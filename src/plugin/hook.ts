import { randomUUID } from "node:crypto";
import {
    chmod,
    lstat,
    mkdir,
    open,
    readFile,
    readdir,
    rename,
    rm,
    rmdir,
    unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import * as Schema from "effect/Schema";

import {
    AlreadyRunning,
    CONTROL_DAEMON_IDENTITY,
    ControlUnavailable,
    controlLockPath,
    controlSocketPath,
    healthControl,
    notifyControl,
    prepareControlSocket,
    prepareControlSocketDirectory,
} from "./control.ts";
import { spawnBackgroundDaemon, type DaemonSpawner } from "./daemon-process.ts";
import { defaultDaemonLog, type DaemonLogCommands } from "./daemon-log.ts";
import {
    HookNotification,
    type DaemonHealth,
    type HookNotification as HookNotificationValue,
} from "./protocol.ts";
import {
    createWindowsLockCandidate,
    discardWindowsLockCandidate,
    publishWindowsLockFile,
    readWindowsLockFile,
    takeWindowsLockFile,
    UnsafeWindowsLockFile,
    WindowsLockContended,
    type WindowsFileIdentity,
    type WindowsLockSnapshot,
    type WindowsLockTake,
} from "./windows-lock.ts";
import { ensureWindowsStateDirectory, isWindowsControlPlatform } from "./windows-pipe.ts";

const CONTROL_READINESS_MS = 1_500;
const LOCK_STALE_MS = 5_000;
const LOCK_POLL_MS = 25;

const NonEmptyText = Schema.String.pipe(Schema.nonEmptyString(), Schema.maxLength(4_096));
const HookEvent = Schema.Struct({
    data: Schema.Struct({
        workspace: Schema.optional(Schema.Struct({ workspace_id: NonEmptyText })),
        workspace_id: Schema.optional(NonEmptyText),
    }),
});
const HookContext = Schema.Struct({ workspace_cwd: NonEmptyText });
const LockContentsSchema = Schema.Struct({
    pid: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
    token: NonEmptyText,
    createdAt: Schema.Number.pipe(Schema.finite()),
});

type LockContents = Schema.Schema.Type<typeof LockContentsSchema>;

interface LockIdentity {
    readonly dev: number;
    readonly ino: number;
}

export interface HookControlApi {
    readonly controlSocketPath: (environment: NodeJS.ProcessEnv) => string;
    readonly healthControl: (path: string, timeoutMs?: number) => Promise<DaemonHealth>;
    readonly prepareControlSocket: (path: string) => Promise<void>;
    readonly prepareControlSocketDirectory: (path: string) => Promise<void>;
    readonly notifyControl: (
        path: string,
        notification: HookNotification,
        timeoutMs?: number,
    ) => Promise<void>;
}

export interface HookStartupOptions {
    readonly control?: HookControlApi;
    readonly environment?: NodeJS.ProcessEnv;
    readonly log?: DaemonLogCommands;
    readonly now?: () => number;
    readonly pid?: number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
    readonly spawnDaemon?: DaemonSpawner;
    readonly token?: () => string;
}

export type HookStartupResult =
    | { readonly _tag: "Skipped"; readonly reason: "missing_workspace_or_cwd" }
    | { readonly _tag: "Notified"; readonly startedDaemon: boolean };

export type EnsureDaemonResult = {
    readonly status: "started" | "already_running";
    readonly daemon: DaemonHealth;
};

export class HookStartupError extends Error {
    readonly _tag = "HookStartupError";

    constructor(
        readonly operation: "lock" | "log" | "readiness" | "spawn",
        message: string,
    ) {
        super(message);
        this.name = "HookStartupError";
    }
}

const defaultControl: HookControlApi = {
    controlSocketPath,
    healthControl,
    prepareControlSocket,
    prepareControlSocketDirectory,
    notifyControl,
};

const delay = (milliseconds: number): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, milliseconds);
    return promise;
};

const awaitWithinDeadline = async <Value>(
    operation: Promise<Value>,
    deadline: number,
    now: () => number,
): Promise<Value> => {
    const remaining = deadline - now();
    if (remaining <= 0) {
        void operation.catch(() => undefined);
        throw new HookStartupError("readiness", "Timed out waiting for control socket readiness");
    }

    const timeout = Promise.withResolvers<void>();
    const timer = setTimeout(timeout.resolve, remaining);
    try {
        const result = await Promise.race([
            operation.then((value) => ({ value })),
            timeout.promise.then(() => undefined),
        ]);
        if (result === undefined) {
            throw new HookStartupError(
                "readiness",
                "Timed out waiting for control socket readiness",
            );
        }
        return result.value;
    } finally {
        clearTimeout(timer);
    }
};

const invokeWithinDeadline = async <Value>(
    invoke: () => Promise<Value>,
    deadline: number,
    now: () => number,
): Promise<Value> => {
    if (deadline - now() <= 0) {
        throw new HookStartupError("readiness", "Timed out waiting for control socket readiness");
    }
    return awaitWithinDeadline(invoke(), deadline, now);
};

const decodeNonEmptyText = (value: unknown): string | undefined => {
    const decoded = Schema.decodeUnknownEither(NonEmptyText)(value);
    return decoded._tag === "Right" ? decoded.right : undefined;
};

const decodeJson = <A, I>(
    schema: Schema.Schema<A, I>,
    value: string | undefined,
): A | undefined => {
    if (value === undefined) {
        return undefined;
    }
    const decoded = Schema.decodeUnknownEither(Schema.parseJson(schema))(value);
    return decoded._tag === "Right" ? decoded.right : undefined;
};

/** Decode only the documented HerdR hook payload and context variables. */
export const decodeHookNotification = (
    environment: NodeJS.ProcessEnv = process.env,
): HookNotificationValue | undefined => {
    const event = decodeJson(HookEvent, environment.HERDR_PLUGIN_EVENT_JSON);
    const workspaceId =
        event?.data.workspace?.workspace_id ??
        event?.data.workspace_id ??
        decodeNonEmptyText(environment.HERDR_WORKSPACE_ID);
    const context = decodeJson(HookContext, environment.HERDR_PLUGIN_CONTEXT_JSON);
    if (workspaceId === undefined || context === undefined) {
        return undefined;
    }

    const notification = Schema.decodeUnknownEither(HookNotification)({
        workspaceId,
        cwd: context.workspace_cwd,
    });
    return notification._tag === "Right" ? notification.right : undefined;
};

const isNodeError = (error: unknown, code: string): boolean =>
    typeof error === "object" && error !== null && "code" in error && error.code === code;

const currentUid = (): number | undefined => process.getuid?.();

const sameIdentity = (left: LockIdentity, right: LockIdentity): boolean =>
    left.dev === right.dev && left.ino === right.ino;

const lockIdentity = (stat: { readonly dev: number; readonly ino: number }): LockIdentity => ({
    dev: stat.dev,
    ino: stat.ino,
});

const parseLock = (value: string): LockContents | undefined =>
    decodeJson(LockContentsSchema, value);

interface LockInspection {
    readonly createdAt: number;
    readonly identity: LockIdentity;
    readonly lock: LockContents | undefined;
    readonly ownerIdentity: LockIdentity | undefined;
    readonly ownerPath: string | undefined;
}

const lockOwnerPath = (path: string, token: string): string => join(path, `${token}.json`);

const inspectLock = async (path: string): Promise<LockInspection> => {
    const directory = await lstat(path);
    if (
        directory.isSymbolicLink() ||
        !directory.isDirectory() ||
        (directory.mode & 0o777) !== 0o700 ||
        (currentUid() !== undefined && directory.uid !== currentUid())
    ) {
        throw new HookStartupError("lock", `Refusing unsafe hook lock at ${path}`);
    }

    const entries = await readdir(path);
    if (entries.length === 0) {
        return {
            createdAt: directory.mtimeMs,
            identity: lockIdentity(directory),
            lock: undefined,
            ownerIdentity: undefined,
            ownerPath: undefined,
        };
    }
    if (entries.length !== 1 || !entries[0]?.endsWith(".json")) {
        throw new HookStartupError("lock", `Refusing malformed hook lock directory at ${path}`);
    }

    const ownerPath = join(path, entries[0]);
    const owner = await lstat(ownerPath);
    if (
        owner.isSymbolicLink() ||
        !owner.isFile() ||
        (owner.mode & 0o777) !== 0o600 ||
        (currentUid() !== undefined && owner.uid !== currentUid())
    ) {
        throw new HookStartupError("lock", `Refusing unsafe hook lock owner at ${path}`);
    }

    const lock = parseLock(await readFile(ownerPath, "utf8"));
    if (lock === undefined || ownerPath !== lockOwnerPath(path, lock.token)) {
        throw new HookStartupError("lock", `Refusing malformed hook lock owner at ${path}`);
    }

    return {
        createdAt: lock.createdAt,
        identity: lockIdentity(directory),
        lock,
        ownerIdentity: lockIdentity(owner),
        ownerPath,
    };
};

const removeEmptyLockDirectory = async (
    path: string,
    expectedIdentity: LockIdentity,
): Promise<boolean> => {
    let current: LockInspection;
    try {
        current = await inspectLock(path);
    } catch (error) {
        if (isNodeError(error, "ENOENT")) {
            return false;
        }
        throw error;
    }
    if (!sameIdentity(expectedIdentity, current.identity) || current.lock !== undefined) {
        return false;
    }

    try {
        await rmdir(path);
        return true;
    } catch (error) {
        if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTEMPTY")) {
            return false;
        }
        throw error;
    }
};

const removeCapturedLock = async (path: string, current: LockInspection): Promise<boolean> => {
    if (current.lock === undefined || current.ownerPath === undefined) {
        return removeEmptyLockDirectory(path, current.identity);
    }

    try {
        await unlink(current.ownerPath);
    } catch (error) {
        if (isNodeError(error, "ENOENT")) {
            return false;
        }
        throw error;
    }
    return removeEmptyLockDirectory(path, current.identity);
};

const removeStaleLock = async (path: string, now: number): Promise<boolean> => {
    let initial: LockInspection;
    try {
        initial = await inspectLock(path);
    } catch (error) {
        if (isNodeError(error, "ENOENT")) {
            return false;
        }
        throw error;
    }

    if (now - initial.createdAt < LOCK_STALE_MS) {
        return false;
    }

    let current: LockInspection;
    try {
        current = await inspectLock(path);
    } catch (error) {
        if (isNodeError(error, "ENOENT")) {
            return false;
        }
        throw error;
    }

    if (!sameIdentity(initial.identity, current.identity)) {
        return false;
    }
    if (
        initial.lock !== undefined &&
        (current.lock === undefined ||
            current.lock.token !== initial.lock.token ||
            initial.ownerIdentity === undefined ||
            current.ownerIdentity === undefined ||
            initial.ownerPath !== current.ownerPath ||
            !sameIdentity(initial.ownerIdentity, current.ownerIdentity))
    ) {
        return false;
    }
    if (initial.lock === undefined && current.lock !== undefined) {
        return false;
    }

    return removeCapturedLock(path, current);
};

const writeLockOwner = async (path: string, contents: LockContents): Promise<void> => {
    const ownerPath = lockOwnerPath(path, contents.token);
    const file = await open(ownerPath, "wx", 0o600);
    try {
        await file.writeFile(JSON.stringify(contents));
    } finally {
        await file.close();
    }
    await chmod(ownerPath, 0o600);
};

interface WindowsLockInspection {
    readonly contents: LockContents;
    readonly identity: WindowsFileIdentity;
}

/**
 * Read a Windows lock file together with its stable NTFS identity. Unlike the
 * POSIX layout there is no lock directory: NTFS reports a synthetic mode and
 * uid 0, so ownership comes from the inherited user-only state-directory ACL
 * and durability from an atomic exclusive create.
 */
const inspectWindowsLock = async (path: string): Promise<WindowsLockInspection | null> => {
    let snapshot: WindowsLockSnapshot | null;
    try {
        snapshot = await readWindowsLockFile(path);
    } catch (error) {
        // A live or foreign handle denies access with EBUSY/EACCES/EPERM. That
        // is contention, not a verdict: report "no lock visible right now" so
        // callers poll again instead of failing the hook or taking over a live
        // lock.
        if (error instanceof WindowsLockContended) {
            return null;
        }
        if (error instanceof UnsafeWindowsLockFile) {
            throw new HookStartupError(
                "lock",
                `Refusing unsafe hook lock at ${path}: ${error.reason}`,
            );
        }
        throw new HookStartupError(
            "lock",
            `Unable to inspect hook lock at ${path}: ${String(error)}`,
        );
    }
    if (snapshot === null) {
        return null;
    }

    const contents = parseLock(snapshot.contents);
    if (contents === undefined) {
        throw new HookStartupError("lock", `Refusing malformed hook lock at ${path}`);
    }
    return { contents, identity: snapshot.identity };
};

const removeStaleWindowsLock = async (path: string, now: number): Promise<boolean> => {
    const initial = await inspectWindowsLock(path);
    if (initial === null || now - initial.contents.createdAt < LOCK_STALE_MS) {
        return false;
    }

    const current = await inspectWindowsLock(path);
    if (current === null) {
        return false;
    }
    if (current.contents.token !== initial.contents.token) {
        return false;
    }
    if (!sameIdentity(initial.identity, current.identity)) {
        return false;
    }
    if (now - current.contents.createdAt < LOCK_STALE_MS) {
        return false;
    }

    let taken: WindowsLockTake;
    try {
        taken = await takeWindowsLockFile(path, current.identity);
    } catch (error) {
        // Rename/unlink failures after both inspections are not a hook verdict;
        // surface them as this module's lock error instead of a raw fs error.
        throw new HookStartupError(
            "lock",
            `Unable to remove stale hook lock at ${path}: ${String(error)}`,
        );
    }
    return taken === "taken";
};

const acquireWindowsLock = async (
    path: string,
    contents: LockContents,
    deadline: number,
    now: () => number,
    sleep: (milliseconds: number) => Promise<void>,
): Promise<void> => {
    try {
        await ensureWindowsStateDirectory(dirname(path));
    } catch (error) {
        throw new HookStartupError(
            "lock",
            `Unable to prepare hook lock directory for ${path}: ${String(error)}`,
        );
    }

    // The candidate name carries this process's random token, so any leftover is
    // this invocation's own abandoned artifact rather than a contended lock.
    const candidate = `${path}.${contents.token}.tmp`;
    await discardWindowsLockCandidate(candidate).catch(() => undefined);

    for (;;) {
        try {
            await createWindowsLockCandidate(candidate, JSON.stringify(contents));
        } catch (error) {
            // Only this invocation's token can collide with its candidate name,
            // so a collision means an abandoned artifact or a dying handle, not
            // a contended lock. Discard and keep polling.
            if (isNodeError(error, "EEXIST") || isNodeError(error, "EBUSY")) {
                await discardWindowsLockCandidate(candidate).catch(() => undefined);
                if (now() >= deadline) {
                    throw new HookStartupError(
                        "readiness",
                        "Timed out waiting for control socket readiness",
                    );
                }
                await sleep(LOCK_POLL_MS);
                continue;
            }
            throw new HookStartupError(
                "lock",
                `Unable to write hook lock owner at ${path}: ${String(error)}`,
            );
        }

        let acquired = false;
        try {
            await publishWindowsLockFile(candidate, path);
            acquired = true;
        } catch (error) {
            await discardWindowsLockCandidate(candidate).catch(() => undefined);
            if (!isNodeError(error, "EEXIST")) {
                throw new HookStartupError(
                    "lock",
                    `Unable to acquire hook lock at ${path}: ${String(error)}`,
                );
            }
        }
        if (acquired) {
            return;
        }

        await removeStaleWindowsLock(path, now());
        if (now() >= deadline) {
            throw new HookStartupError(
                "readiness",
                "Timed out waiting for control socket readiness",
            );
        }
        await sleep(LOCK_POLL_MS);
    }
};

const releaseWindowsLock = async (path: string, token: string): Promise<void> => {
    const current = await inspectWindowsLock(path);
    if (current !== null && current.contents.token === token) {
        // A denied capture must not turn a successful hook into a failure; the
        // stale takeover path will collect an abandoned lock later.
        await takeWindowsLockFile(path, current.identity).catch(() => undefined);
    }
    // Collect this invocation's candidate if publish could not unlink it.
    await discardWindowsLockCandidate(`${path}.${token}.tmp`).catch(() => undefined);
};

const acquireLock = async (
    path: string,
    contents: LockContents,
    deadline: number,
    now: () => number,
    sleep: (milliseconds: number) => Promise<void>,
): Promise<void> => {
    if (isWindowsControlPlatform()) {
        await acquireWindowsLock(path, contents, deadline, now, sleep);
        return;
    }
    const candidate = `${path}.${contents.token}.tmp`;
    for (;;) {
        try {
            await mkdir(candidate, { mode: 0o700 });
            await chmod(candidate, 0o700);
        } catch (error) {
            throw new HookStartupError(
                "lock",
                `Unable to create hook lock candidate at ${path}: ${String(error)}`,
            );
        }

        try {
            await writeLockOwner(candidate, contents);
        } catch (error) {
            await rm(candidate, { recursive: true, force: true });
            throw new HookStartupError(
                "lock",
                `Unable to write hook lock owner at ${path}: ${String(error)}`,
            );
        }

        let canonicalExists = false;
        try {
            await lstat(path);
            canonicalExists = true;
        } catch (error) {
            if (!isNodeError(error, "ENOENT")) {
                await rm(candidate, { recursive: true, force: true });
                throw new HookStartupError(
                    "lock",
                    `Unable to inspect hook lock at ${path}: ${String(error)}`,
                );
            }
        }

        if (!canonicalExists) {
            try {
                await rename(candidate, path);
                return;
            } catch (error) {
                await rm(candidate, { recursive: true, force: true });
                if (!isNodeError(error, "EEXIST") && !isNodeError(error, "ENOTEMPTY")) {
                    throw new HookStartupError(
                        "lock",
                        `Unable to acquire hook lock at ${path}: ${String(error)}`,
                    );
                }
            }
        } else {
            await rm(candidate, { recursive: true, force: true });
        }

        await removeStaleLock(path, now());
        if (now() >= deadline) {
            throw new HookStartupError(
                "readiness",
                "Timed out waiting for control socket readiness",
            );
        }
        await sleep(LOCK_POLL_MS);
    }
};

const releaseLock = async (path: string, token: string): Promise<void> => {
    if (isWindowsControlPlatform()) {
        await releaseWindowsLock(path, token);
        return;
    }
    let current: LockInspection;
    try {
        current = await inspectLock(path);
    } catch (error) {
        if (isNodeError(error, "ENOENT")) {
            return;
        }
        throw error;
    }

    if (current.lock === undefined || current.lock.token !== token) {
        return;
    }

    let final: LockInspection;
    try {
        final = await inspectLock(path);
    } catch (error) {
        if (isNodeError(error, "ENOENT")) {
            return;
        }
        throw error;
    }
    if (
        final.lock === undefined ||
        final.lock.token !== token ||
        current.ownerIdentity === undefined ||
        final.ownerIdentity === undefined ||
        current.ownerPath !== final.ownerPath ||
        !sameIdentity(current.identity, final.identity) ||
        !sameIdentity(current.ownerIdentity, final.ownerIdentity)
    ) {
        return;
    }

    await removeCapturedLock(path, final);
};

const checkedHealth = async (
    control: HookControlApi,
    path: string,
    deadline: number,
    now: () => number,
): Promise<DaemonHealth> => {
    const daemon = await invokeWithinDeadline(
        () => control.healthControl(path, Math.max(1, deadline - now())),
        deadline,
        now,
    );
    if (daemon.identity !== CONTROL_DAEMON_IDENTITY) {
        throw new HookStartupError(
            "readiness",
            "Control socket returned the wrong daemon identity",
        );
    }
    return daemon;
};

export const ensureDaemon = async (
    options: HookStartupOptions = {},
    deadline = (options.now ?? Date.now)() + CONTROL_READINESS_MS,
): Promise<EnsureDaemonResult> => {
    const environment = options.environment ?? process.env;
    const control = options.control ?? defaultControl;
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? delay;
    const path = control.controlSocketPath(environment);
    await invokeWithinDeadline(() => control.prepareControlSocketDirectory(path), deadline, now);
    try {
        return {
            status: "already_running",
            daemon: await checkedHealth(control, path, deadline, now),
        };
    } catch (error) {
        if (!(error instanceof ControlUnavailable)) throw error;
        if (now() >= deadline)
            throw new HookStartupError(
                "readiness",
                "Timed out waiting for control socket readiness",
            );
    }

    const lockPath = controlLockPath(path, environment);
    const lockToken = (options.token ?? randomUUID)();
    await acquireLock(
        lockPath,
        { pid: options.pid ?? process.pid, token: lockToken, createdAt: now() },
        deadline,
        now,
        sleep,
    );
    try {
        try {
            return {
                status: "already_running",
                daemon: await checkedHealth(control, path, deadline, now),
            };
        } catch (error) {
            if (!(error instanceof ControlUnavailable)) throw error;
            if (now() >= deadline)
                throw new HookStartupError(
                    "readiness",
                    "Timed out waiting for control socket readiness",
                );
        }
        try {
            await invokeWithinDeadline(() => control.prepareControlSocket(path), deadline, now);
        } catch (error) {
            if (!(error instanceof AlreadyRunning)) throw error;
            return {
                status: "already_running",
                daemon: await checkedHealth(control, path, deadline, now),
            };
        }
        const log = options.log ?? defaultDaemonLog;
        try {
            await invokeWithinDeadline(
                () => log.preflight(log.path(path, environment)),
                deadline,
                now,
            );
        } catch (error) {
            if (error instanceof HookStartupError) throw error;
            throw new HookStartupError(
                "log",
                `Unable to prepare daemon log: ${String(error).slice(-4096)}`,
            );
        }
        let child: ReturnType<DaemonSpawner>;
        try {
            if (now() >= deadline)
                throw new HookStartupError(
                    "readiness",
                    "Timed out waiting for control socket readiness",
                );
            child = (options.spawnDaemon ?? spawnBackgroundDaemon)(environment);
        } catch (error) {
            if (error instanceof HookStartupError) throw error;
            throw new HookStartupError(
                "spawn",
                `Unable to start daemon: ${String(error).slice(-4096)}`,
            );
        }
        let exitCode: number | undefined;
        void child.exited.then(
            (code) => {
                exitCode = code;
            },
            () => {
                exitCode = -1;
            },
        );
        try {
            for (;;) {
                if (exitCode !== undefined)
                    throw new HookStartupError("readiness", `Daemon exited with code ${exitCode}`);
                if (now() >= deadline)
                    throw new HookStartupError(
                        "readiness",
                        "Timed out waiting for control socket readiness",
                    );
                try {
                    return {
                        status: "started",
                        daemon: await checkedHealth(control, path, deadline, now),
                    };
                } catch (error) {
                    if (!(error instanceof ControlUnavailable)) throw error;
                    await invokeWithinDeadline(
                        () => sleep(Math.min(LOCK_POLL_MS, Math.max(0, deadline - now()))),
                        deadline,
                        now,
                    );
                }
            }
        } catch (error) {
            child.kill();
            throw error;
        }
    } finally {
        await releaseLock(lockPath, lockToken);
    }
};

export const runHook = async (options: HookStartupOptions = {}): Promise<HookStartupResult> => {
    const environment = options.environment ?? process.env;
    const notification = decodeHookNotification(environment);
    if (notification === undefined) return { _tag: "Skipped", reason: "missing_workspace_or_cwd" };
    const now = options.now ?? Date.now;
    const deadline = now() + CONTROL_READINESS_MS;
    const result = await ensureDaemon(options, deadline);
    const control = options.control ?? defaultControl;
    const path = control.controlSocketPath(environment);
    await invokeWithinDeadline(
        () => control.notifyControl(path, notification, Math.max(1, deadline - now())),
        deadline,
        now,
    );
    return { _tag: "Notified", startedDaemon: result.status === "started" };
};
