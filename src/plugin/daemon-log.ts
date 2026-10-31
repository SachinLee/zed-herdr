import { createHash } from "node:crypto";
import { constants, ftruncateSync, writeSync, type Stats } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

import {
    ensureWindowsStateDirectory,
    isWindowsControlPlatform,
    windowsStateRoot,
} from "./windows-pipe.ts";

/**
 * One file per control endpoint, rotated by truncation, never by new files, so
 * a detached daemon cannot grow the disk without bound.
 */
export const DAEMON_LOG_MAX_BYTES = 1_048_576;
export const DAEMON_LOG_RECORD_MAX_BYTES = 16 * 1024;
export const DAEMON_LOG_MODE = 0o600;
export const DAEMON_LOG_DIRECTORY_MODE = 0o700;

const LOG_ENTRY_MAX_LENGTH = 4_096;
const LOG_DIGEST_LENGTH = 16;

const TRUNCATION_RECORD = JSON.stringify({
    type: "log_truncated",
    max_bytes: DAEMON_LOG_RECORD_MAX_BYTES,
});

export class DaemonLogError extends Error {
    readonly _tag = "DaemonLogError";

    constructor(
        readonly operation: "path" | "prepare" | "write",
        message: string,
    ) {
        super(message);
        this.name = "DaemonLogError";
    }
}

export interface DaemonLogCommands {
    readonly path: (controlPath: string, environment: NodeJS.ProcessEnv) => string;
    readonly preflight: (path: string) => Promise<void>;
}

export interface DaemonLogHandle {
    readonly path: string;
    readonly writeRecord: (value: unknown) => void;
    readonly writeJsonLine: (line: string) => void;
    readonly close: () => Promise<void>;
}

const bounded = (message: string): string =>
    message.length <= LOG_ENTRY_MAX_LENGTH ? message : message.slice(-LOG_ENTRY_MAX_LENGTH);

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
    error instanceof Error && "code" in error;

const currentUid = (): number | undefined => process.getuid?.();

/** The log lives beside the control endpoint, or under the per-user state root. */
export const daemonLogPath = (
    controlPath: string,
    environment: NodeJS.ProcessEnv = process.env,
): string => {
    const name = `${createHash("sha256").update(controlPath).digest("hex").slice(0, LOG_DIGEST_LENGTH)}.log`;
    if (isWindowsControlPlatform()) {
        const root = windowsStateRoot(environment);
        if (root === undefined) {
            throw new DaemonLogError(
                "path",
                "Unable to derive the daemon log directory: neither LOCALAPPDATA nor USERPROFILE is set",
            );
        }
        return join(root, "logs", name);
    }
    return join(dirname(controlPath), name);
};

export const defaultDaemonLog: DaemonLogCommands = {
    path: daemonLogPath,
    preflight: (path: string): Promise<void> => preflightDaemonLog(path),
};

const prepareLogDirectory = async (path: string): Promise<void> => {
    const directory = dirname(path);
    try {
        if (isWindowsControlPlatform()) {
            await ensureWindowsStateDirectory(directory);
        } else {
            await mkdir(directory, { recursive: true, mode: DAEMON_LOG_DIRECTORY_MODE });
        }
    } catch (error) {
        throw new DaemonLogError(
            "prepare",
            bounded(`Unable to prepare the daemon log directory ${directory}: ${String(error)}`),
        );
    }

    let info: Stats;
    try {
        info = await lstat(directory);
    } catch (error) {
        throw new DaemonLogError(
            "prepare",
            bounded(`Unable to inspect the daemon log directory ${directory}: ${String(error)}`),
        );
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new DaemonLogError(
            "prepare",
            bounded(`Refusing unsafe daemon log directory ${directory}`),
        );
    }
    if (!isWindowsControlPlatform()) {
        const uid = currentUid();
        if (uid !== undefined && info.uid !== uid) {
            throw new DaemonLogError(
                "prepare",
                bounded(`Refusing daemon log directory ${directory} owned by uid ${info.uid}`),
            );
        }
        if ((info.mode & 0o077) !== 0) {
            throw new DaemonLogError(
                "prepare",
                bounded(`Refusing daemon log directory ${directory} reachable by other accounts`),
            );
        }
    }
};

const assertManagedFile = (path: string, info: Stats): void => {
    if (info.isSymbolicLink() || !info.isFile()) {
        throw new DaemonLogError("prepare", bounded(`Refusing unsafe daemon log path ${path}`));
    }
    if (info.nlink > 1) {
        throw new DaemonLogError(
            "prepare",
            bounded(`Refusing daemon log file ${path} with ${info.nlink} links`),
        );
    }
    if (!isWindowsControlPlatform()) {
        const uid = currentUid();
        if (uid !== undefined && info.uid !== uid) {
            throw new DaemonLogError(
                "prepare",
                bounded(`Refusing daemon log file ${path} owned by uid ${info.uid}`),
            );
        }
        if ((info.mode & 0o077) !== 0) {
            throw new DaemonLogError(
                "prepare",
                bounded(`Refusing daemon log file ${path} reachable by other accounts`),
            );
        }
    }
};

const openLogFile = async (path: string): Promise<{ handle: FileHandle; bytes: number }> => {
    let existing: Stats | undefined;
    try {
        existing = await lstat(path);
    } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
            throw new DaemonLogError(
                "prepare",
                bounded(`Unable to inspect daemon log ${path}: ${String(error)}`),
            );
        }
    }
    if (existing !== undefined) {
        assertManagedFile(path, existing);
    }

    let handle: FileHandle;
    try {
        const noFollow = (constants as { readonly O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
        handle = await open(path, constants.O_RDWR | constants.O_CREAT | noFollow, DAEMON_LOG_MODE);
    } catch (error) {
        throw new DaemonLogError(
            "prepare",
            bounded(`Unable to open daemon log ${path}: ${String(error)}`),
        );
    }

    try {
        const info = await handle.stat();
        assertManagedFile(path, info);
        if (existing !== undefined && (existing.dev !== info.dev || existing.ino !== info.ino)) {
            throw new DaemonLogError(
                "prepare",
                bounded(`Daemon log ${path} changed identity while it was opened`),
            );
        }
        if (info.size > DAEMON_LOG_MAX_BYTES) {
            ftruncateSync(handle.fd, 0);
            return { handle, bytes: 0 };
        }
        return { handle, bytes: info.size };
    } catch (error) {
        await handle.close().catch(() => undefined);
        throw error instanceof DaemonLogError
            ? error
            : new DaemonLogError(
                  "prepare",
                  bounded(`Unable to inspect daemon log ${path}: ${String(error)}`),
              );
    }
};

const encodeRecord = (value: unknown): string => {
    if (typeof value === "string") {
        const line = value.trim();
        if (
            line.length > 0 &&
            Buffer.byteLength(line) + 1 <= DAEMON_LOG_RECORD_MAX_BYTES &&
            isJsonRecord(line)
        ) {
            return line;
        }
        return TRUNCATION_RECORD;
    }
    const line = JSON.stringify(value);
    if (
        line === undefined ||
        Buffer.byteLength(line) + 1 > DAEMON_LOG_RECORD_MAX_BYTES ||
        !isJsonRecord(line)
    ) {
        return TRUNCATION_RECORD;
    }
    return line;
};

const isJsonRecord = (line: string): boolean => {
    try {
        const parsed: unknown = JSON.parse(line);
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
    } catch {
        return false;
    }
};

/**
 * Open the single daemon log file. Any failure is reported as a bounded
 * `DaemonLogError`; a write failure is announced exactly once so the daemon can
 * fail its run instead of silently discarding diagnostics.
 */
export const openDaemonLog = async (
    path: string,
    onFailure?: (error: DaemonLogError) => void,
): Promise<DaemonLogHandle> => {
    await prepareLogDirectory(path);
    const opened = await openLogFile(path);
    let bytes = opened.bytes;
    let closed = false;
    let failure: DaemonLogError | undefined;

    const announce = (error: DaemonLogError): DaemonLogError => {
        if (failure === undefined) {
            failure = error;
            try {
                onFailure?.(error);
            } catch {
                // A failing failure callback must not recurse into the log.
            }
        }
        return failure;
    };

    const write = (value: unknown): void => {
        if (failure !== undefined) {
            throw failure;
        }
        try {
            if (closed) {
                throw new DaemonLogError("write", `Daemon log is closed: ${path}`);
            }
            const record = Buffer.from(`${encodeRecord(value)}\n`);
            if (bytes + record.length > DAEMON_LOG_MAX_BYTES) {
                ftruncateSync(opened.handle.fd, 0);
                bytes = 0;
            }
            // Bounded synchronous writes backpressure Effect's synchronous logger.
            let offset = 0;
            while (offset < record.length) {
                const written = writeSync(
                    opened.handle.fd,
                    record,
                    offset,
                    record.length - offset,
                    bytes + offset,
                );
                if (written <= 0) {
                    throw new Error("Daemon log write made no progress");
                }
                offset += written;
            }
            bytes += record.length;
        } catch (error) {
            throw announce(
                error instanceof DaemonLogError
                    ? error
                    : new DaemonLogError(
                          "write",
                          bounded(`Unable to write daemon log ${path}: ${String(error)}`),
                      ),
            );
        }
    };

    return {
        path,
        writeRecord: write,
        writeJsonLine: write,
        close: async () => {
            if (closed) {
                return;
            }
            closed = true;
            await opened.handle.close();
        },
    };
};

/** Prove the destination is writable before a daemon is spawned for it. */
export const preflightDaemonLog = async (path: string): Promise<void> => {
    const log = await openDaemonLog(path);
    try {
        log.writeRecord({ type: "daemon_log_preflight", pid: process.pid });
    } finally {
        await log.close();
    }
};

/** Route every daemon log record, from any layer, into the detached log file. */
export const daemonLogLoggerLayer = (log: DaemonLogHandle): Layer.Layer<never> =>
    Logger.replace(
        Logger.defaultLogger,
        Logger.map(Logger.jsonLogger, (line: string) => {
            try {
                log.writeJsonLine(line);
            } catch {
                // openDaemonLog announces the first failure to the daemon scope.
            }
            return line;
        }),
    );
