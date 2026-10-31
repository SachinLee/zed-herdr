import { createHash } from "node:crypto";
import {
    chmod,
    link,
    lstat,
    mkdir,
    open,
    readlink,
    rename,
    symlink,
    unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import * as Schema from "effect/Schema";

import { resolveHerdRSocketPath } from "../herdr/client.ts";
import {
    ControlRequest,
    ControlResponse,
    type ControlResponse as ControlResponseValue,
    DaemonHealth,
    type HookNotification,
} from "./protocol.ts";
import {
    classifyWindowsControlStartError,
    currentWindowsUserSid,
    isWindowsControlPlatform,
    isWindowsControlPipePath,
    waitForWindowsPipeClosed,
    waitForWindowsPipeReady,
    windowsControlPipePath,
    windowsLockPath,
    windowsPipeOwner,
    windowsPipePresence,
} from "./windows-pipe.ts";

export const CONTROL_SOCKET_MAX_BYTES = 64 * 1024;
export const CONTROL_SOCKET_MODE = 0o600;
export const CONTROL_DAEMON_IDENTITY = "artisann.zed-herdr:daemon" as const;

/** How long a client retries a pipe that reports `occupied` while starting. */
const PIPE_RETRY_MS = 100;
/** How long a freshly bound pipe may take to accept its first connection. */
const PIPE_ACCEPT_TIMEOUT_MS = 500;
/** How long a stop may take, from health probe to an observed closed endpoint. */
export const STOP_CONTROL_TIMEOUT_MS = 5_000;
/** How often a stopping client rechecks that the endpoint is gone. */
const STOP_CLOSE_POLL_MS = 25;

export class AlreadyRunning extends Error {
    readonly _tag = "AlreadyRunning";

    constructor(readonly path: string) {
        super(`A live Zed HerdR control daemon is already listening at ${path}`);
        this.name = "AlreadyRunning";
    }
}

export class UnsafeControlSocket extends Error {
    readonly _tag = "UnsafeControlSocket";

    constructor(
        readonly path: string,
        readonly reason:
            | "foreign_owner"
            | "not_socket"
            | "symlink"
            | "changed_inode"
            | "lstat_failed"
            | "probe_failed"
            | "not_directory"
            | "unsafe_mode"
            | "unsafe_parent",
    ) {
        super(`Refusing to alter unsafe control socket ${path}: ${reason}`);
        this.name = "UnsafeControlSocket";
    }
}

export class ControlUnavailable extends Error {
    readonly _tag = "ControlUnavailable";

    constructor(
        readonly path: string,
        readonly operation: "connect" | "read" | "timeout",
        override readonly cause?: unknown,
    ) {
        super(`Control socket ${operation} failed for ${path}`);
        this.name = "ControlUnavailable";
    }
}

export class ControlProtocolError extends Error {
    readonly _tag = "ControlProtocolError";

    constructor(
        readonly path: string,
        readonly detail: string,
    ) {
        super(`Invalid control response from ${path}: ${detail}`);
        this.name = "ControlProtocolError";
    }
}

export interface ControlNotificationSink {
    readonly publish: (notification: HookNotification) => void | Promise<void>;
}

export interface StartControlServerOptions {
    readonly path: string;
    /** Captured by the daemon at startup; clients never submit or influence this value. */
    readonly paneId: string | null;
    readonly notifications: ControlNotificationSink;
    readonly toggleEnabled?: () => boolean | Promise<boolean>;
    readonly protocolStatus?: () => Pick<DaemonHealth, "protocol" | "beyondTested">;
    /**
     * Requests a graceful shutdown of the owning daemon. Called at most once per
     * bound endpoint, and only after the acknowledgement frame is fully written.
     */
    readonly stopRequested?: () => void;
}

export interface ControlServer {
    readonly path: string;
    readonly daemon: DaemonHealth;
    close(): Promise<void>;
}

type SocketIdentity = {
    readonly dev: number;
    readonly ino: number;
};

const textEncoder = new TextEncoder();

const currentUid = (): number => {
    const uid = process.getuid?.();
    if (uid === undefined) {
        throw new UnsafeControlSocket("/tmp", "lstat_failed");
    }
    return uid;
};

const sameIdentity = (left: SocketIdentity, right: SocketIdentity): boolean =>
    left.dev === right.dev && left.ino === right.ino;

const isMissing = (error: unknown): error is NodeJS.ErrnoException =>
    typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const isAlreadyPresent = (error: unknown): error is NodeJS.ErrnoException =>
    typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";

const restoreWithoutClobbering = async (preservedPath: string, path: string): Promise<boolean> => {
    const preserved = await lstat(preservedPath);
    try {
        if (preserved.isSymbolicLink()) {
            await symlink(await readlink(preservedPath), path);
        } else if (preserved.isFile() || preserved.isSocket()) {
            await link(preservedPath, path);
        } else {
            throw new UnsafeControlSocket(path, "changed_inode");
        }
        await unlink(preservedPath);
        return true;
    } catch (error) {
        if (isAlreadyPresent(error)) {
            return false;
        }
        throw error;
    }
};

const isRefused = (error: unknown): error is NodeJS.ErrnoException =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ECONNREFUSED" || error.code === "ENOENT");

const closeSocket = (socket: Bun.Socket<undefined>): void => {
    try {
        socket.end();
    } catch {
        socket.terminate();
    }
};

/** Narrow injection seam for fail-closed liveness tests. */
export interface ControlSocketConnector {
    connect(path: string): Promise<Bun.Socket<undefined>>;
}

const bunControlSocketConnector: ControlSocketConnector = {
    connect(path) {
        return Bun.connect({
            unix: path,
            socket: {
                data() {},
            },
        });
    },
};

export const probeControlSocket = async (
    path: string,
    timeoutMs = 150,
    connector: ControlSocketConnector = bunControlSocketConnector,
): Promise<boolean> => {
    let timedOut = false;
    let opened: Bun.Socket<undefined> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connection = connector.connect(path);
    const timeout = new Promise<never>((_resolveTimeout, rejectTimeout) => {
        timer = setTimeout(() => {
            timedOut = true;
            rejectTimeout(new UnsafeControlSocket(path, "probe_failed"));
        }, timeoutMs);
    });

    try {
        return await Promise.race([
            connection.then(
                (socket) => {
                    opened = socket;
                    return true;
                },
                (error: unknown) => {
                    if (isRefused(error)) {
                        return false;
                    }
                    throw new UnsafeControlSocket(path, "probe_failed");
                },
            ),
            timeout,
        ]);
    } finally {
        clearTimeout(timer);
        if (opened !== undefined) {
            closeSocket(opened);
        } else if (timedOut) {
            void connection.then(closeSocket).catch(() => undefined);
        }
    }
};

/**
 * Derive the per-HerdR-session control endpoint that only the owning account may
 * write to. POSIX uses a `0600` Unix socket; Windows uses a named pipe whose
 * write access is limited by its DACL, scoped by account SID, and whose owner is
 * verified before a request is written (see `windows-pipe.ts`).
 */
export const controlSocketPath = (environment: NodeJS.ProcessEnv = process.env): string => {
    const configuredSocket = resolveHerdRSocketPath(environment);
    if (isWindowsControlPlatform()) {
        const normalized = configuredSocket.trim().replaceAll("/", "\\").toLowerCase();
        // The account SID scopes the name so two users of one machine never share
        // a pipe. It is an identifier, not a secret: it only has to be stable.
        // Without it there is no consistent per-account name, so fail closed rather
        // than fall back to a shared digest that two accounts could both derive.
        const scope = currentWindowsUserSid();
        if (scope === undefined) {
            throw new UnsafeControlSocket(normalized, "lstat_failed");
        }
        const digest = createHash("sha256")
            .update(`${scope}\u0000${normalized}`)
            .digest("hex")
            .slice(0, 16);
        return windowsControlPipePath(digest);
    }
    const herdRSocket = resolve(configuredSocket);
    const digest = createHash("sha256").update(herdRSocket).digest("hex").slice(0, 16);
    const configuredRuntimeBase = environment.XDG_RUNTIME_DIR?.trim();
    const runtimeBase =
        configuredRuntimeBase === undefined || configuredRuntimeBase.length === 0
            ? dirname(herdRSocket)
            : resolve(configuredRuntimeBase);
    return join(runtimeBase, "zed-herdr", `${digest}.sock`);
};

/**
 * Hook startup lock for a control endpoint. POSIX keeps the sibling
 * `<path>.lock` directory; Windows uses a lock file under the per-account state
 * root, keyed by the endpoint, because a pipe name has no filesystem sibling.
 */
export const controlLockPath = (
    path: string,
    environment: NodeJS.ProcessEnv = process.env,
): string => {
    if (!isWindowsControlPlatform()) {
        return `${path}.lock`;
    }
    const lockPath = windowsLockPath(path, environment);
    if (lockPath === undefined) {
        throw new UnsafeControlSocket(path, "unsafe_parent");
    }
    return lockPath;
};

const validateControlSocketParent = async (path: string): Promise<void> => {
    const parent = dirname(path);
    try {
        const stat = await lstat(parent);
        if (
            stat.isSymbolicLink() ||
            !stat.isDirectory() ||
            stat.uid !== currentUid() ||
            (stat.mode & 0o022) !== 0
        ) {
            throw new UnsafeControlSocket(path, "unsafe_parent");
        }
    } catch (error) {
        if (error instanceof UnsafeControlSocket) {
            throw error;
        }
        throw new UnsafeControlSocket(path, "unsafe_parent");
    }
};

const validateControlSocketDirectory = async (path: string): Promise<boolean> => {
    try {
        const stat = await lstat(path);
        if (stat.isSymbolicLink()) {
            throw new UnsafeControlSocket(path, "symlink");
        }
        if (!stat.isDirectory()) {
            throw new UnsafeControlSocket(path, "not_directory");
        }
        if (stat.uid !== currentUid()) {
            throw new UnsafeControlSocket(path, "foreign_owner");
        }
        if ((stat.mode & 0o777) !== 0o700) {
            await chmod(path, 0o700);
            const tightened = await lstat(path);
            if (
                tightened.isSymbolicLink() ||
                !tightened.isDirectory() ||
                tightened.uid !== currentUid() ||
                (tightened.mode & 0o777) !== 0o700
            ) {
                throw new UnsafeControlSocket(path, "unsafe_mode");
            }
        }
        return true;
    } catch (error) {
        if (isMissing(error)) {
            return false;
        }
        if (error instanceof UnsafeControlSocket) {
            throw error;
        }
        throw new UnsafeControlSocket(path, "unsafe_mode");
    }
};

/**
 * Prepare and revalidate the container of a control endpoint. POSIX creates a
 * `0700` directory around the socket; a Windows pipe has no filesystem parent, so
 * only the derived per-session name is validated there.
 */
export const prepareControlSocketDirectory = async (path: string): Promise<void> => {
    if (isWindowsControlPlatform()) {
        // A named pipe has no filesystem parent. Its DACL, created by the kernel
        // from Bun's listen call, is the ownership boundary instead, so only the
        // derived per-session name is accepted.
        if (!isWindowsControlPipePath(path)) {
            throw new UnsafeControlSocket(path, "unsafe_parent");
        }
        return;
    }
    const directory = dirname(path);
    await validateControlSocketParent(directory);
    if (!(await validateControlSocketDirectory(directory))) {
        try {
            await mkdir(directory, { mode: 0o700 });
        } catch (error) {
            if (!isAlreadyPresent(error)) {
                throw new UnsafeControlSocket(directory, "unsafe_mode");
            }
        }
    }
    if (!(await validateControlSocketDirectory(directory))) {
        throw new UnsafeControlSocket(directory, "unsafe_mode");
    }
};

const lstatOwnedSocket = async (path: string): Promise<SocketIdentity | null> => {
    try {
        const stat = await lstat(path);
        if (stat.isSymbolicLink()) {
            throw new UnsafeControlSocket(path, "symlink");
        }
        if (!stat.isSocket()) {
            throw new UnsafeControlSocket(path, "not_socket");
        }
        if (stat.uid !== currentUid()) {
            throw new UnsafeControlSocket(path, "foreign_owner");
        }
        return { dev: stat.dev, ino: stat.ino };
    } catch (error) {
        if (isMissing(error)) {
            return null;
        }
        if (error instanceof UnsafeControlSocket) {
            throw error;
        }
        throw new UnsafeControlSocket(path, "lstat_failed");
    }
};

/**
 * Safely clear an orphaned socket. It never unlinks a path without first proving it
 * is the same current-user Unix socket that was found after a failed liveness probe.
 */
export const prepareControlSocket = async (path: string): Promise<void> => {
    if (isWindowsControlPlatform()) {
        // Named pipes are kernel-managed and disappear with their last instance,
        // so there is no orphan to quarantine. Only prove that the name is free;
        // a pipe held by another account is refused before any probe connects to
        // it, and a pipe that exists but never accepts fails closed.
        if (!isWindowsControlPipePath(path)) {
            throw new UnsafeControlSocket(path, "not_socket");
        }
        const presence = await windowsPipePresence(path);
        if (presence === "absent") {
            return;
        }
        if (presence === "occupied") {
            throw new UnsafeControlSocket(path, "probe_failed");
        }
        switch (windowsPipeOwner(path)) {
            case "own":
                break;
            case "foreign":
                throw new UnsafeControlSocket(path, "foreign_owner");
            default:
                throw new UnsafeControlSocket(path, "probe_failed");
        }
        if (await probeControlSocket(path)) {
            throw new AlreadyRunning(path);
        }
        return;
    }
    const before = await lstatOwnedSocket(path);

    if (await probeControlSocket(path)) {
        const live = await lstatOwnedSocket(path);
        if (live === null || (before !== null && !sameIdentity(before, live))) {
            throw new UnsafeControlSocket(path, "changed_inode");
        }
        throw new AlreadyRunning(path);
    }

    const afterFirstProbe = await lstatOwnedSocket(path);
    if (
        (before === null && afterFirstProbe !== null) ||
        (before !== null && (afterFirstProbe === null || !sameIdentity(before, afterFirstProbe)))
    ) {
        throw new UnsafeControlSocket(path, "changed_inode");
    }
    if (afterFirstProbe === null) {
        if (await probeControlSocket(path)) {
            const live = await lstatOwnedSocket(path);
            if (live === null) {
                throw new UnsafeControlSocket(path, "changed_inode");
            }
            throw new AlreadyRunning(path);
        }
        return;
    }

    if (await probeControlSocket(path)) {
        const live = await lstatOwnedSocket(path);
        if (live === null || !sameIdentity(afterFirstProbe, live)) {
            throw new UnsafeControlSocket(path, "changed_inode");
        }
        throw new AlreadyRunning(path);
    }

    const afterSecondProbe = await lstatOwnedSocket(path);
    if (afterSecondProbe === null || !sameIdentity(afterFirstProbe, afterSecondProbe)) {
        throw new UnsafeControlSocket(path, "changed_inode");
    }

    const quarantinePath = `${path}.quarantine-${crypto.randomUUID()}`;
    try {
        await rename(path, quarantinePath);
    } catch (error) {
        if (isMissing(error)) {
            throw new UnsafeControlSocket(path, "changed_inode");
        }
        throw error;
    }

    let matchesExpectedInode = false;
    try {
        const quarantined = await lstat(quarantinePath);
        matchesExpectedInode =
            quarantined.dev === afterSecondProbe.dev && quarantined.ino === afterSecondProbe.ino;
    } catch {
        // The pathname was removed or replaced after atomic capture. Do not touch the canonical path.
    }
    if (!matchesExpectedInode) {
        await restoreWithoutClobbering(quarantinePath, path);
        throw new UnsafeControlSocket(path, "changed_inode");
    }
    await unlink(quarantinePath);
};

const encodeResponse = (response: ControlResponseValue): string => `${JSON.stringify(response)}\n`;

const writeAndClose = (
    socket: Bun.Socket<ConnectionState>,
    response: ControlResponseValue,
): void => {
    try {
        socket.end(encodeResponse(response));
    } catch {
        // The peer vanished before reading its response (a Windows named pipe
        // reports EPIPE once the client closed); there is nobody left to answer.
        socket.terminate();
    }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, expected: ReadonlyArray<string>): boolean => {
    const actual = Object.keys(value);
    return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
};

const isDaemonHealthShaped = (value: unknown): boolean =>
    isRecord(value) &&
    hasExactKeys(value, ["identity", "paneId", "pid", "startedAt", "protocol", "beyondTested"]);

const isExactControlResponse = (value: unknown): value is Record<string, unknown> => {
    if (!isRecord(value)) {
        return false;
    }
    if (value.ok === true) {
        if (hasExactKeys(value, ["ok"])) {
            return true;
        }
        if (hasExactKeys(value, ["ok", "enabled"])) {
            return typeof value.enabled === "boolean";
        }
        if (hasExactKeys(value, ["ok", "stopping", "daemon"])) {
            return value.stopping === true && isDaemonHealthShaped(value.daemon);
        }
        return hasExactKeys(value, ["ok", "daemon"]) && isDaemonHealthShaped(value.daemon);
    }
    return value.ok === false && hasExactKeys(value, ["ok", "error"]);
};

type ConnectionState = {
    buffer: string;
    bytes: number;
    completed: boolean;
    decoder: TextDecoder;
    newlineSeen: boolean;
    scheduled: boolean;
    /** Remainder of a stop acknowledgement the transport has not yet accepted. */
    pendingStop: Uint8Array | null;
};

const responseFor = (
    encoded: string,
    notificationSink: ControlNotificationSink,
    toggleEnabled: StartControlServerOptions["toggleEnabled"],
    daemon: () => DaemonHealth,
    socket: Bun.Socket<ConnectionState>,
    requestStop: (() => void) | undefined,
): void => {
    let raw: unknown;
    try {
        raw = JSON.parse(encoded);
    } catch {
        writeAndClose(socket, { ok: false, error: "invalid_request" });
        return;
    }

    const decoded = Schema.decodeUnknownEither(ControlRequest)(raw);
    if (decoded._tag === "Left") {
        writeAndClose(socket, { ok: false, error: "invalid_request" });
        return;
    }

    if (decoded.right.type === "health") {
        try {
            writeAndClose(socket, { ok: true, daemon: daemon() });
        } catch {
            writeAndClose(socket, { ok: false, error: "server_failure" });
        }
        return;
    }

    if (decoded.right.type === "stop") {
        if (requestStop === undefined) {
            writeAndClose(socket, { ok: false, error: "server_failure" });
            return;
        }
        let current: DaemonHealth;
        try {
            current = daemon();
        } catch {
            writeAndClose(socket, { ok: false, error: "server_failure" });
            return;
        }
        const requested = decoded.right.daemon;
        if (
            requested.identity !== current.identity ||
            requested.pid !== current.pid ||
            requested.startedAt !== current.startedAt
        ) {
            // A stale or fabricated target never stops the live daemon.
            writeAndClose(socket, { ok: false, error: "invalid_request" });
            return;
        }
        // `write`/`end` report how many bytes of the frame the transport actually
        // accepted (`bun-types` 5809/5818). The shutdown request is signalled only
        // after the whole frame is accepted; a short write is completed from the
        // documented `drain` event, so the acknowledgement is never truncated by a
        // teardown that races a partially written reply.
        let acknowledgement: Uint8Array;
        try {
            acknowledgement = textEncoder.encode(
                encodeResponse({ ok: true, stopping: true, daemon: current }),
            );
        } catch {
            writeAndClose(socket, { ok: false, error: "server_failure" });
            return;
        }
        let written: number;
        try {
            written = socket.write(acknowledgement);
        } catch {
            // The peer vanished (EPIPE on a closed Windows pipe): nobody is left
            // to receive the acknowledgement, so the daemon must keep running.
            socket.terminate();
            return;
        }
        if (written < 0) {
            socket.terminate();
            return;
        }
        if (written === acknowledgement.byteLength) {
            socket.end();
            requestStop();
            return;
        }
        socket.data.pendingStop = acknowledgement.subarray(written);
        return;
    }

    if (decoded.right.type === "toggle") {
        if (toggleEnabled === undefined) {
            writeAndClose(socket, { ok: false, error: "server_failure" });
            return;
        }
        let toggled: boolean | Promise<boolean>;
        try {
            toggled = toggleEnabled();
        } catch {
            writeAndClose(socket, { ok: false, error: "server_failure" });
            return;
        }
        void Promise.resolve(toggled).then(
            (enabled) => writeAndClose(socket, { ok: true, enabled }),
            () => writeAndClose(socket, { ok: false, error: "server_failure" }),
        );
        return;
    }

    let published: void | Promise<void>;
    try {
        published = notificationSink.publish(decoded.right.notification);
    } catch {
        writeAndClose(socket, { ok: false, error: "server_failure" });
        return;
    }
    void Promise.resolve(published).then(
        () => writeAndClose(socket, { ok: true }),
        () => writeAndClose(socket, { ok: false, error: "server_failure" }),
    );
};

/**
 * Bind the daemon's control endpoint and return a finalizer that never removes an
 * endpoint it does not own. POSIX uses an inode-safe `0600` Unix socket; Windows
 * uses a named pipe whose DACL restricts write access to the owning account and
 * whose owner is verified after binding (see `windows-pipe.ts`).
 */
export const startControlServer = async (
    options: StartControlServerOptions,
): Promise<ControlServer> => {
    const startedAt = new Date().toISOString();
    const daemon = (): DaemonHealth => {
        const protocolStatus = options.protocolStatus?.() ?? {
            protocol: null,
            beyondTested: false,
        };
        const daemonResult = Schema.decodeUnknownEither(DaemonHealth)({
            identity: CONTROL_DAEMON_IDENTITY,
            paneId: options.paneId,
            pid: process.pid,
            startedAt,
            ...protocolStatus,
        });
        if (daemonResult._tag === "Left") {
            throw new ControlProtocolError(options.path, "invalid daemon health");
        }
        return daemonResult.right;
    };
    void daemon();

    await prepareControlSocketDirectory(options.path);
    await prepareControlSocket(options.path);

    const listener = bindControlListener(options, daemon);
    if (isWindowsControlPlatform()) {
        return await startWindowsControlServer(options, listener, daemon);
    }
    return await startPosixControlServer(options, listener, daemon);
};

/** Bind the platform control listener with the shared single-frame protocol. */
const bindControlListener = (
    options: StartControlServerOptions,
    daemon: () => DaemonHealth,
): Bun.UnixSocketListener<ConnectionState> => {
    try {
        return (() => {
            // One acknowledged stop per bound endpoint: a second request must not
            // enqueue a second shutdown of the same daemon.
            let stopLatched = false;
            const requestStop = (): void => {
                if (stopLatched) {
                    return;
                }
                stopLatched = true;
                try {
                    options.stopRequested?.();
                } catch {
                    // A failing shutdown request must never escape the listener.
                }
            };
            const processBufferedRequest = (socket: Bun.Socket<ConnectionState>): void => {
                if (socket.data.completed) {
                    return;
                }
                const newline = socket.data.buffer.indexOf("\n");
                if (newline < 0 || socket.data.buffer.slice(newline + 1).length > 0) {
                    socket.data.completed = true;
                    writeAndClose(socket, { ok: false, error: "invalid_request" });
                    return;
                }
                const frame = socket.data.buffer.slice(0, newline).replace(/\r$/, "");
                if (textEncoder.encode(frame).byteLength > CONTROL_SOCKET_MAX_BYTES) {
                    socket.data.completed = true;
                    writeAndClose(socket, { ok: false, error: "payload_too_large" });
                    return;
                }
                socket.data.completed = true;
                responseFor(
                    frame,
                    options.notifications,
                    options.toggleEnabled,
                    daemon,
                    socket,
                    options.stopRequested === undefined ? undefined : requestStop,
                );
            };
            const priorUmask = process.umask(0o177);
            try {
                return Bun.listen<ConnectionState>({
                    unix: options.path,
                    allowHalfOpen: true,
                    socket: {
                        open(socket) {
                            socket.data = {
                                buffer: "",
                                bytes: 0,
                                newlineSeen: false,
                                completed: false,
                                decoder: new TextDecoder("utf-8", { fatal: true }),
                                scheduled: false,
                                pendingStop: null,
                            };
                        },
                        data(socket, chunk) {
                            if (socket.data.completed) {
                                return;
                            }
                            socket.data.bytes += chunk.byteLength;
                            const newlineByte = chunk.indexOf(0x0a);
                            if (
                                socket.data.newlineSeen ||
                                (newlineByte >= 0 && newlineByte < chunk.byteLength - 1)
                            ) {
                                socket.data.completed = true;
                                writeAndClose(socket, { ok: false, error: "invalid_request" });
                                return;
                            }
                            if (newlineByte >= 0) {
                                socket.data.newlineSeen = true;
                            }
                            try {
                                socket.data.buffer += socket.data.decoder.decode(chunk, {
                                    stream: true,
                                });
                            } catch {
                                socket.data.completed = true;
                                writeAndClose(socket, { ok: false, error: "invalid_request" });
                                return;
                            }

                            const newline = socket.data.buffer.indexOf("\n");
                            if (newline >= 0) {
                                if (socket.data.buffer.slice(newline + 1).length > 0) {
                                    socket.data.completed = true;
                                    writeAndClose(socket, { ok: false, error: "invalid_request" });
                                    return;
                                }
                                const frame = socket.data.buffer
                                    .slice(0, newline)
                                    .replace(/\r$/, "");
                                if (
                                    textEncoder.encode(frame).byteLength > CONTROL_SOCKET_MAX_BYTES
                                ) {
                                    socket.data.completed = true;
                                    writeAndClose(socket, {
                                        ok: false,
                                        error: "payload_too_large",
                                    });
                                    return;
                                }
                                if (!socket.data.scheduled) {
                                    socket.data.scheduled = true;
                                    setImmediate(() => processBufferedRequest(socket));
                                }
                                return;
                            }

                            if (
                                socket.data.bytes >
                                CONTROL_SOCKET_MAX_BYTES +
                                    (socket.data.buffer.endsWith("\r") ? 1 : 0)
                            ) {
                                socket.data.completed = true;
                                writeAndClose(socket, { ok: false, error: "payload_too_large" });
                            }
                        },
                        end(socket) {
                            if (socket.data.completed) {
                                return;
                            }
                            if (isWindowsControlPlatform()) {
                                // A Windows named pipe rejects a response to a peer that
                                // already closed (`EPIPE`), so the peer-close event can
                                // never deliver a reply. Complete frames are answered from
                                // the data path; anything left here is discarded.
                                socket.terminate();
                                return;
                            }
                            try {
                                socket.data.buffer += socket.data.decoder.decode();
                            } catch {
                                socket.data.completed = true;
                                writeAndClose(socket, { ok: false, error: "invalid_request" });
                                return;
                            }
                            processBufferedRequest(socket);
                        },
                        drain(socket) {
                            // A partially accepted stop acknowledgement is completed
                            // here; only a fully written frame may request shutdown.
                            const pending = socket.data.pendingStop;
                            if (pending === null) {
                                return;
                            }
                            const written = socket.write(pending);
                            if (written < 0) {
                                socket.data.pendingStop = null;
                                socket.terminate();
                                return;
                            }
                            if (written !== pending.byteLength) {
                                socket.data.pendingStop = pending.subarray(written);
                                return;
                            }
                            socket.data.pendingStop = null;
                            socket.end();
                            requestStop();
                        },
                    },
                });
            } finally {
                process.umask(priorUmask);
            }
        })();
    } catch (error) {
        if (isWindowsControlPlatform()) {
            if (classifyWindowsControlStartError(error) === "already_running") {
                throw new AlreadyRunning(options.path);
            }
            // A name that exists but cannot be bound belongs to another instance
            // (`EBUSY`/`EADDRINUSE` is already reported as `AlreadyRunning`). A
            // denial or unexpected kernel rejection is never reused: fail closed
            // instead of surfacing a transport error a caller could retry.
            throw new UnsafeControlSocket(options.path, "probe_failed");
        }
        throw error;
    }
};

const startPosixControlServer = async (
    options: StartControlServerOptions,
    listener: Bun.UnixSocketListener<ConnectionState>,
    daemon: () => DaemonHealth,
): Promise<ControlServer> => {
    try {
        const boundStat = await lstat(options.path);
        if (
            !boundStat.isSocket() ||
            boundStat.isSymbolicLink() ||
            boundStat.uid !== currentUid() ||
            (boundStat.mode & 0o777) !== CONTROL_SOCKET_MODE
        ) {
            throw new UnsafeControlSocket(options.path, "lstat_failed");
        }
        const identity: SocketIdentity = { dev: boundStat.dev, ino: boundStat.ino };

        let listenerStopped = false;
        let closing: Promise<void> | null = null;
        return {
            path: options.path,
            get daemon() {
                return daemon();
            },
            close(): Promise<void> {
                if (listenerStopped) {
                    return Promise.resolve();
                }
                if (closing !== null) {
                    return closing;
                }

                closing = (async () => {
                    const preservedPaths: Array<string> = [];
                    try {
                        for (;;) {
                            const preservedPath = `${options.path}.preserve-${crypto.randomUUID()}`;
                            try {
                                await rename(options.path, preservedPath);
                                preservedPaths.push(preservedPath);
                            } catch (error) {
                                if (!isMissing(error)) {
                                    throw error;
                                }
                            }

                            try {
                                const guard = await open(options.path, "wx", CONTROL_SOCKET_MODE);
                                await guard.close();
                                break;
                            } catch (error) {
                                if (!isAlreadyPresent(error)) {
                                    throw error;
                                }
                            }
                        }
                    } finally {
                        listener.stop(true);
                        listenerStopped = true;
                    }

                    for (const preservedPath of preservedPaths) {
                        let preserved: SocketIdentity | null = null;
                        try {
                            const stat = await lstat(preservedPath);
                            preserved = { dev: stat.dev, ino: stat.ino };
                        } catch (error) {
                            if (!isMissing(error)) {
                                throw error;
                            }
                        }
                        if (preserved === null) {
                            continue;
                        }
                        if (sameIdentity(identity, preserved)) {
                            await unlink(preservedPath);
                            continue;
                        }
                        await restoreWithoutClobbering(preservedPath, options.path);
                    }
                })();
                return closing;
            },
        };
    } catch (error) {
        const preservedPaths: Array<string> = [];
        try {
            for (;;) {
                const preservedPath = `${options.path}.startup-preserve-${crypto.randomUUID()}`;
                try {
                    await rename(options.path, preservedPath);
                    preservedPaths.push(preservedPath);
                } catch (renameError) {
                    if (!isMissing(renameError)) {
                        throw renameError;
                    }
                }

                try {
                    const guard = await open(options.path, "wx", CONTROL_SOCKET_MODE);
                    await guard.close();
                    break;
                } catch (guardError) {
                    if (!isAlreadyPresent(guardError)) {
                        throw guardError;
                    }
                }
            }
        } finally {
            listener.stop(true);
        }

        for (const preservedPath of preservedPaths) {
            await restoreWithoutClobbering(preservedPath, options.path);
        }
        throw error;
    }
};

/**
 * Confirm the bound named pipe and return a finalizer that only stops the
 * listener. Windows has no on-disk endpoint to preserve, and the kernel removes
 * the name once the last instance closes, so nothing is ever unlinked here.
 *
 * The pipe we just bound must be owned by this account. This is a diagnostic
 * gate, not the authorization boundary: the kernel already restricts writes to
 * the creating user (plus administrators/SYSTEM) through the default pipe DACL.
 */
/**
 * Wait, bounded, until a freshly bound pipe actually accepts a connection.
 *
 * A named pipe can become visible to `lstat` before Bun's listener is accepting,
 * so a client that connects the instant `startControlServer` resolves would see
 * a spurious "connect failed". Resolving startup only after one successful probe
 * makes "started" mean "connectable" for every caller.
 */
const waitForWindowsPipeAccepting = async (
    path: string,
    timeoutMs = PIPE_ACCEPT_TIMEOUT_MS,
): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            if (await probeControlSocket(path, 50)) {
                return true;
            }
        } catch {
            // A pipe that is still being created can fail the probe outright;
            // keep waiting so startup reports a single, actionable verdict.
        }
        if (Date.now() >= deadline) {
            return false;
        }
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
    }
};

const startWindowsControlServer = async (
    options: StartControlServerOptions,
    listener: Bun.UnixSocketListener<ConnectionState>,
    daemon: () => DaemonHealth,
): Promise<ControlServer> => {
    try {
        // A just-bound pipe can be reported as `EBUSY` for a few milliseconds.
        // Resolve only once the endpoint is actually visible, so callers never
        // observe "started" followed by "connect failed".
        if (!(await waitForWindowsPipeReady(options.path))) {
            throw new UnsafeControlSocket(options.path, "lstat_failed");
        }
        if (!(await waitForWindowsPipeAccepting(options.path))) {
            throw new UnsafeControlSocket(options.path, "probe_failed");
        }
        // Require a positive same-account verdict here too: a post-bind owner
        // that cannot be read is not evidence that this fresh instance is ours.
        switch (windowsPipeOwner(options.path)) {
            case "own":
                break;
            case "foreign":
                throw new UnsafeControlSocket(options.path, "foreign_owner");
            default:
                throw new UnsafeControlSocket(options.path, "probe_failed");
        }

        let listenerStopped = false;
        let closing: Promise<void> | null = null;
        return {
            path: options.path,
            get daemon() {
                return daemon();
            },
            close(): Promise<void> {
                if (listenerStopped) {
                    return Promise.resolve();
                }
                if (closing !== null) {
                    return closing;
                }

                closing = (async () => {
                    listener.stop(true);
                    listenerStopped = true;
                    await waitForWindowsPipeClosed(options.path);
                })();
                return closing;
            },
        };
    } catch (error) {
        listener.stop(true);
        await waitForWindowsPipeClosed(options.path);
        throw error;
    }
};

type ControlSuccessKind = "health" | "notify" | "stop" | "toggle";

/**
 * Every success response carries exactly one discriminator key. A client only
 * accepts the acknowledgement for the command it actually sent, so a stop
 * reply can never satisfy a health probe (and vice versa).
 */
const successKind = (response: Record<string, unknown>): ControlSuccessKind => {
    if (response.stopping === true) {
        return "stop";
    }
    if (typeof response.enabled === "boolean") {
        return "toggle";
    }
    return "daemon" in response ? "health" : "notify";
};

const requestControl = async (
    path: string,
    request: unknown,
    timeoutMs: number,
    expected: ControlSuccessKind,
): Promise<ControlResponseValue> => {
    const deadline = Date.now() + timeoutMs;
    return new Promise<ControlResponseValue>((resolveResponse, rejectResponse) => {
        let socket: Bun.Socket<undefined> | undefined;
        let settled = false;
        let buffer = "";
        let bytes = 0;
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let responseNewlineSeen = false;
        const finish = (result: () => void): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            result();
        };
        const expire = (): void => {
            finish(() => rejectResponse(new ControlUnavailable(path, "timeout")));
            socket?.terminate();
        };
        const timer = setTimeout(expire, Math.max(0, deadline - Date.now()));
        const expired = (): boolean => {
            if (!settled && Date.now() >= deadline) {
                expire();
            }
            return settled;
        };
        const finishResponse = (
            client: Bun.Socket<undefined>,
            incompleteIsUnavailable: boolean,
        ): void => {
            if (expired()) {
                return;
            }
            try {
                buffer += decoder.decode();
            } catch {
                finish(() => rejectResponse(new ControlProtocolError(path, "invalid UTF-8")));
                client.terminate();
                return;
            }
            const newline = buffer.indexOf("\n");
            if (newline < 0) {
                finish(() =>
                    rejectResponse(
                        incompleteIsUnavailable
                            ? new ControlUnavailable(path, "read")
                            : new ControlProtocolError(path, "invalid response framing"),
                    ),
                );
                client.terminate();
                return;
            }
            if (buffer.slice(newline + 1).length > 0) {
                finish(() =>
                    rejectResponse(new ControlProtocolError(path, "invalid response framing")),
                );
                client.terminate();
                return;
            }
            const frame = buffer.slice(0, newline).replace(/\r$/, "");
            if (textEncoder.encode(frame).byteLength > CONTROL_SOCKET_MAX_BYTES) {
                finish(() =>
                    rejectResponse(new ControlProtocolError(path, "response exceeds 64KiB")),
                );
                client.terminate();
                return;
            }
            let parsed: unknown;
            try {
                parsed = JSON.parse(frame);
            } catch {
                finish(() => rejectResponse(new ControlProtocolError(path, "invalid JSON")));
                client.terminate();
                return;
            }
            if (!isExactControlResponse(parsed)) {
                finish(() =>
                    rejectResponse(new ControlProtocolError(path, "unexpected response shape")),
                );
                client.terminate();
                return;
            }
            const decoded = Schema.decodeUnknownEither(ControlResponse)(parsed);
            if (decoded._tag === "Left") {
                finish(() => rejectResponse(new ControlProtocolError(path, "invalid response")));
                client.terminate();
                return;
            }
            if (decoded.right.ok === false || successKind(parsed) !== expected) {
                finish(() =>
                    rejectResponse(
                        new ControlProtocolError(path, `${expected} was not acknowledged`),
                    ),
                );
                client.terminate();
                return;
            }
            finish(() => resolveResponse(decoded.right));
            client.terminate();
        };

        void (async () => {
            const windows = isWindowsControlPlatform();
            const identity = windows ? null : await lstatOwnedSocket(path);
            if (expired()) {
                return;
            }
            if (identity === null) {
                // Windows has no stable inode: verify presence and owner before
                // writing, under the same deadline as the connection/response.
                if (!windows) {
                    throw new ControlUnavailable(path, "connect");
                }
                const presence = await windowsPipePresence(path);
                if (expired()) {
                    return;
                }
                const ready =
                    presence === "present" ||
                    (presence === "occupied" &&
                        (await waitForWindowsPipeReady(
                            path,
                            Math.min(PIPE_RETRY_MS, deadline - Date.now()),
                        )));
                if (expired()) {
                    return;
                }
                if (!ready) {
                    throw new ControlUnavailable(path, "connect");
                }
                switch (windowsPipeOwner(path)) {
                    case "own":
                        break;
                    case "foreign":
                        throw new UnsafeControlSocket(path, "foreign_owner");
                    case "unavailable":
                        throw new ControlUnavailable(path, "connect");
                    default:
                        throw new UnsafeControlSocket(path, "probe_failed");
                }
            }
            if (expired()) {
                return;
            }
            await Bun.connect({
                unix: path,
                allowHalfOpen: true,
                socket: {
                    data(client, chunk) {
                        if (settled) {
                            return;
                        }
                        bytes += chunk.byteLength;
                        const newlineByte = chunk.indexOf(0x0a);
                        if (
                            responseNewlineSeen ||
                            (newlineByte >= 0 && newlineByte < chunk.byteLength - 1)
                        ) {
                            finish(() =>
                                rejectResponse(
                                    new ControlProtocolError(path, "trailing response bytes"),
                                ),
                            );
                            client.terminate();
                            return;
                        }
                        if (newlineByte >= 0) {
                            responseNewlineSeen = true;
                        }
                        try {
                            buffer += decoder.decode(chunk, { stream: true });
                        } catch {
                            finish(() =>
                                rejectResponse(new ControlProtocolError(path, "invalid UTF-8")),
                            );
                            client.terminate();
                            return;
                        }

                        const newline = buffer.indexOf("\n");
                        if (newline >= 0) {
                            if (buffer.slice(newline + 1).length > 0) {
                                finish(() =>
                                    rejectResponse(
                                        new ControlProtocolError(path, "trailing response bytes"),
                                    ),
                                );
                                client.terminate();
                                return;
                            }
                            const frame = buffer.slice(0, newline).replace(/\r$/, "");
                            if (textEncoder.encode(frame).byteLength > CONTROL_SOCKET_MAX_BYTES) {
                                finish(() =>
                                    rejectResponse(
                                        new ControlProtocolError(path, "response exceeds 64KiB"),
                                    ),
                                );
                                client.terminate();
                            }
                            return;
                        }

                        if (bytes > CONTROL_SOCKET_MAX_BYTES + (buffer.endsWith("\r") ? 1 : 0)) {
                            finish(() =>
                                rejectResponse(
                                    new ControlProtocolError(path, "response exceeds 64KiB"),
                                ),
                            );
                            client.terminate();
                        }
                    },
                    end(client) {
                        finishResponse(client, false);
                    },
                    close(client, closeError) {
                        if (closeError !== null && closeError !== undefined) {
                            finish(() =>
                                rejectResponse(new ControlUnavailable(path, "read", closeError)),
                            );
                            return;
                        }
                        finishResponse(client, true);
                    },
                    error(_client, socketError) {
                        finish(() =>
                            rejectResponse(new ControlUnavailable(path, "read", socketError)),
                        );
                    },
                },
            }).then(
                (connected) => {
                    socket = connected;
                    if (expired()) {
                        connected.terminate();
                        return;
                    }
                    if (identity === null) {
                        // Windows: a named pipe has no comparable identity to recheck.
                        connected.write(`${JSON.stringify(request)}\n`);
                        return;
                    }
                    void lstatOwnedSocket(path).then(
                        (current) => {
                            if (expired()) {
                                connected.terminate();
                                return;
                            }
                            if (current === null || !sameIdentity(identity, current)) {
                                finish(() =>
                                    rejectResponse(new ControlUnavailable(path, "connect")),
                                );
                                connected.terminate();
                                return;
                            }
                            connected.write(`${JSON.stringify(request)}\n`);
                        },
                        (lstatError: unknown) => {
                            finish(() => rejectResponse(lstatError));
                            connected.terminate();
                        },
                    );
                },
                (connectError: unknown) =>
                    finish(() =>
                        rejectResponse(new ControlUnavailable(path, "connect", connectError)),
                    ),
            );
        })().catch((error: unknown) => finish(() => rejectResponse(error)));
    });
};

export const notifyControl = async (
    path: string,
    notification: HookNotification,
    timeoutMs = 1_500,
): Promise<void> => {
    const response = await requestControl(
        path,
        { type: "notify", notification },
        timeoutMs,
        "notify",
    );
    if (response.ok !== true) {
        throw new ControlProtocolError(path, "notify was not acknowledged");
    }
};

export const healthControl = async (path: string, timeoutMs = 500): Promise<DaemonHealth> => {
    const response = await requestControl(path, { type: "health" }, timeoutMs, "health");
    if (response.ok !== true || !("daemon" in response) || "stopping" in response) {
        throw new ControlProtocolError(path, "health was not acknowledged");
    }
    return response.daemon;
};

export const toggleControl = async (path: string, timeoutMs = 500): Promise<boolean> => {
    const response = await requestControl(path, { type: "toggle" }, timeoutMs, "toggle");
    if (response.ok !== true || !("enabled" in response)) {
        throw new ControlProtocolError(path, "toggle was not acknowledged");
    }
    return response.enabled;
};

/**
 * Whether the control endpoint is provably gone. Only an absent name (Windows)
 * or a missing directory entry (POSIX) proves the daemon finished its cleanup:
 * a pipe that is still `occupied` by a closing instance, and any entry that
 * `lstat` refuses to describe, remain "not closed" so the caller keeps waiting
 * until its deadline instead of reporting a stop that never finished.
 */
const controlEndpointClosed = async (path: string): Promise<boolean> => {
    if (isWindowsControlPlatform()) {
        switch (await windowsPipePresence(path)) {
            case "absent":
                return true;
            case "present":
            case "occupied":
                return false;
            default:
                throw new ControlUnavailable(path, "connect");
        }
    }
    try {
        await lstat(path);
        return false;
    } catch (error) {
        if (isMissing(error)) {
            return true;
        }
        // EACCES/EPERM/ELOOP and friends say nothing about the daemon's state.
        throw new ControlUnavailable(path, "read", error);
    }
};

const waitForControlEndpointClosed = async (path: string, deadline: number): Promise<void> => {
    for (;;) {
        if (await controlEndpointClosed(path)) {
            return;
        }
        if (Date.now() >= deadline) {
            throw new ControlUnavailable(path, "timeout");
        }
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, STOP_CLOSE_POLL_MS));
    }
};

/**
 * Ask the daemon that owns `path` to shut down. The target identity is read from
 * the daemon itself (never supplied by the caller), so a stale or spoofed
 * request cannot stop a process the caller never observed. Returns the daemon
 * that acknowledged the stop, after its endpoint is observed closed.
 */
export const stopControl = async (
    path: string,
    timeoutMs = STOP_CONTROL_TIMEOUT_MS,
): Promise<DaemonHealth> => {
    const deadline = Date.now() + timeoutMs;
    // The health probe is part of the operator's stop budget: it must not spend
    // its own default while the surrounding deadline keeps running.
    const healthBudget = deadline - Date.now();
    if (healthBudget <= 0) {
        throw new ControlUnavailable(path, "timeout");
    }
    const target = await healthControl(path, healthBudget);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
        throw new ControlUnavailable(path, "timeout");
    }
    const response = await requestControl(
        path,
        { type: "stop", daemon: target },
        remaining,
        "stop",
    );
    if (response.ok !== true || !("stopping" in response) || !("daemon" in response)) {
        throw new ControlProtocolError(path, "stop was not acknowledged");
    }
    // The acknowledgement must name the daemon that was asked: a reply for a
    // different instance is not proof that this endpoint is stopping.
    const acknowledged = response.daemon;
    if (
        acknowledged.identity !== target.identity ||
        acknowledged.pid !== target.pid ||
        acknowledged.startedAt !== target.startedAt
    ) {
        throw new ControlProtocolError(path, "stop acknowledged a different daemon");
    }
    await waitForControlEndpointClosed(path, deadline);
    return acknowledged;
};
