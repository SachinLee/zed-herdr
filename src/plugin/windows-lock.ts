/**
 * Windows lock-file primitives for the plugin hook startup lock.
 *
 * NTFS still reports a stable `(dev, ino)` pair for regular files, so ownership
 * of a lock file can be proven the same way the POSIX directory lock proves it.
 * Two Windows details shape this module:
 *
 * - `rename` replaces an existing destination through `MoveFileExW`, so it
 *   cannot be used to publish or restore a lock. `link` fails with `EEXIST`
 *   instead, which makes hard links the atomic publish/restore primitive.
 * - File modes are synthesized (`0666` for files and directories) and `uid` is
 *   always `0`. The directory policy is inherited from the per-user state root
 *   (see `windows-pipe.ts`), and the lock files below never widen it.
 *
 * Every removal is identity-checked: a captured file is moved to a unique
 * quarantine name, compared with the inspected identity, and only then unlinked.
 * A mismatched capture is linked back without clobbering a newer lock.
 */
import { link, lstat, open, readFile, rename, unlink } from "node:fs/promises";

export interface WindowsFileIdentity {
    readonly dev: number;
    readonly ino: number;
}

export interface WindowsLockSnapshot {
    readonly contents: string;
    readonly identity: WindowsFileIdentity;
}

export type WindowsLockTake = "absent" | "changed" | "taken";

export class UnsafeWindowsLockFile extends Error {
    readonly _tag = "UnsafeWindowsLockFile";

    constructor(
        readonly path: string,
        readonly reason: "lstat_failed" | "not_file" | "read_failed" | "symlink",
    ) {
        super(`Refusing unsafe hook lock file ${path}: ${reason}`);
        this.name = "UnsafeWindowsLockFile";
    }
}

/**
 * The lock file exists but another handle currently denies access to it.
 *
 * Windows reports a sharing violation as `EBUSY` (measured with a foreign
 * `FileShare.None` handle) and an ACL denial as `EACCES`/`EPERM`. Neither is a
 * verdict about the lock: the caller must poll again rather than treat the lock
 * as malformed, unsafe, or free.
 */
export class WindowsLockContended extends Error {
    readonly _tag = "WindowsLockContended";

    constructor(
        readonly path: string,
        readonly code: string,
    ) {
        super(`Hook lock file ${path} is temporarily unavailable: ${code}`);
        this.name = "WindowsLockContended";
    }
}

const CONTENTION_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

const errorCode = (error: unknown): string | undefined =>
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;

const isNodeError = (error: unknown, code: string): boolean => errorCode(error) === code;

/** True for the transient Windows codes a live or foreign handle can produce. */
export const isWindowsLockContentionError = (error: unknown): boolean => {
    const code = errorCode(error);
    return code !== undefined && CONTENTION_CODES.has(code);
};

export const sameWindowsFileIdentity = (
    left: WindowsFileIdentity,
    right: WindowsFileIdentity,
): boolean => left.dev === right.dev && left.ino === right.ino;

/** Read a lock file without following links; `null` means no lock is published. */
export const readWindowsLockFile = async (path: string): Promise<WindowsLockSnapshot | null> => {
    let stat;
    try {
        stat = await lstat(path);
    } catch (error) {
        if (isNodeError(error, "ENOENT")) {
            return null;
        }
        throw new UnsafeWindowsLockFile(path, "lstat_failed");
    }
    if (stat.isSymbolicLink()) {
        throw new UnsafeWindowsLockFile(path, "symlink");
    }
    if (!stat.isFile()) {
        throw new UnsafeWindowsLockFile(path, "not_file");
    }

    let contents: string;
    try {
        contents = await readFile(path, "utf8");
    } catch (error) {
        if (isNodeError(error, "ENOENT")) {
            return null;
        }
        if (isWindowsLockContentionError(error)) {
            throw new WindowsLockContended(path, errorCode(error) ?? "unknown");
        }
        throw new UnsafeWindowsLockFile(path, "read_failed");
    }
    return { contents, identity: { dev: stat.dev, ino: stat.ino } };
};

const discardWindowsLockFile = async (path: string): Promise<void> => {
    try {
        await unlink(path);
    } catch (error) {
        if (!isNodeError(error, "ENOENT")) {
            throw error;
        }
    }
};

/** Create a fully written candidate file; `EEXIST` means our own stale candidate. */
export const createWindowsLockCandidate = async (path: string, contents: string): Promise<void> => {
    const file = await open(path, "wx", 0o600);
    let identity: WindowsFileIdentity | undefined;
    try {
        const stat = await file.stat();
        identity = { dev: stat.dev, ino: stat.ino };
        await file.writeFile(contents);
    } catch (error) {
        await file.close().catch(() => undefined);
        if (identity === undefined) {
            await discardWindowsLockFile(path).catch(() => undefined);
        } else {
            await takeWindowsLockFile(path, identity).catch(() => undefined);
        }
        throw error;
    }
    await file.close();
};

/**
 * Publish a candidate as the canonical lock. `link` is exclusive on both
 * platforms, so losing the race surfaces as `EEXIST` without replacing a live
 * lock or exposing a partially written one.
 */
export const publishWindowsLockFile = async (candidate: string, path: string): Promise<void> => {
    await link(candidate, path);
    // The canonical name is published; a leftover hard link to the same file is
    // harmless litter, so never fail an acquire that already succeeded.
    await discardWindowsLockFile(candidate).catch(() => undefined);
};

export const discardWindowsLockCandidate = async (candidate: string): Promise<void> => {
    await discardWindowsLockFile(candidate);
};

/** Atomically remove a lock file only while it is still the inspected file. */
export const takeWindowsLockFile = async (
    path: string,
    expected: WindowsFileIdentity,
): Promise<WindowsLockTake> => {
    const quarantine = `${path}.stale-${crypto.randomUUID()}`;
    try {
        await rename(path, quarantine);
    } catch (error) {
        if (isNodeError(error, "ENOENT")) {
            return "absent";
        }
        if (isWindowsLockContentionError(error)) {
            // A live handle denies the move; nothing was captured, so report
            // "not taken" and let the caller poll again.
            return "changed";
        }
        throw error;
    }

    let captured: WindowsFileIdentity | undefined;
    try {
        const stat = await lstat(quarantine);
        captured = { dev: stat.dev, ino: stat.ino };
    } catch {
        captured = undefined;
    }

    if (captured === undefined || !sameWindowsFileIdentity(captured, expected)) {
        try {
            await link(quarantine, path);
            await discardWindowsLockFile(quarantine);
        } catch {
            // A newer lock already owns the canonical name: leave the capture
            // under its unique quarantine name instead of overwriting anything.
        }
        return "changed";
    }

    await discardWindowsLockFile(quarantine);
    return "taken";
};
