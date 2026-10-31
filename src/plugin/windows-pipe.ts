/**
 * Windows named-pipe transport for the plugin control channel.
 *
 * Authorization assumptions, measured on Bun 1.4.x / win32:
 *
 * - Bun creates the pipe with the default named-pipe DACL, measured as
 *   `(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)(A;;FR;;;WD)(A;;FR;;;AN)`. Full
 *   control, including write, is granted only to SYSTEM, Builtin Administrators
 *   and the creating account; Everyone and Anonymous are granted *read* access
 *   (`FR`). A request must be written, so the kernel admits only the owning
 *   account (plus administrators/SYSTEM) as a client.
 * - That is a write boundary, **not** confidentiality. Any local account may open
 *   the pipe read-only, so the endpoint's existence and its single-frame
 *   responses are observable to a peer that can guess the name, and request bytes
 *   are not private either. This protocol only answers requests, so a peer that
 *   cannot write never receives a payload; any unsolicited server push would need
 *   a different transport.
 *
 * Peer identity: Bun exposes no peer-owner query, so the client inspects the
 * serving object before writing. `windowsPipeOwner` opens the pipe with
 * `CreateFileW`, reads the owner SID through `GetSecurityInfo(SE_KERNEL_OBJECT,
 * OWNER)` and compares it with this process's token `TokenUser` SID (`bun:ffi`,
 * no added dependency). A pipe owned by another account is refused with
 * `UnsafeControlSocket("foreign_owner")`. That check is advisory, not an
 * authentication handshake: it is made on a *separate* handle that is closed
 * before `Bun.connect` opens the connection the request is actually written to,
 * so a name that changes owner between the check and the write is not detected
 * (TOCTOU). A squatter running as *the same* account is indistinguishable from the
 * daemon: it can pre-create the name, receive published cwd hints and forge
 * `{ok: true}` responses, which the client cannot detect. Windows support therefore
 * assumes a trusted local account/host; the owner check raises the cost for a
 * *different* account, it does not authenticate the peer.
 *
 * Name: `\\.\pipe\zed-herdr-<16 hex>`, where the digest covers the resolved HerdR
 * socket **and** the current account SID, so two accounts on the same machine do
 * not share a name. The SID is an identifier, not a secret: the name is not
 * derivable from the HerdR path alone, but it is not unguessable, which is why the
 * owner check above matters.
 *
 * Residual risks:
 * - Another account that guesses the per-user name can still hold it and make the
 *   daemon fail closed (denial of service without impersonation). Such a pipe is
 *   normally refused as `foreign_owner`, but the check is not atomic with the
 *   connect (see the TOCTOU note above).
 * - A same-account attacker can pre-create the name, observe the channel, receive
 *   cwd hints and forge responses. See the trusted-local-host note above.
 * - The kernel removes the name with the last instance, so orphans never exist and
 *   nothing is ever unlinked here. Bun binds with `FILE_FLAG_FIRST_PIPE_INSTANCE`,
 *   so a second daemon fails closed with `EADDRINUSE` instead of sharing a name.
 *
 * `lstat` on a live pipe reports a fresh pseudo-inode on every call, a fabricated
 * `0666` mode and `uid === 0`, while a filesystem AF_UNIX socket cannot be
 * inspected at all while listening, so POSIX `0700`/`0600`/same-uid checks have no
 * Windows equivalent and are deliberately not attempted.
 */
import { dlopen, FFIType, type Pointer, ptr, read, toArrayBuffer } from "bun:ffi";
import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const CONTROL_PIPE_PREFIX = "\\\\.\\pipe\\zed-herdr-";
const CONTROL_PIPE_PATTERN = /^\\\\\.\\pipe\\zed-herdr-[0-9a-f]{16}$/i;
const HEX_DIGEST = /^[0-9a-f]{16}$/;
const STATE_DIRECTORY_NAME = "zed-herdr";
const LOCK_DIRECTORY_NAME = "locks";
const CLOSE_POLL_MS = 10;
const CLOSE_TIMEOUT_MS = 500;
const READY_TIMEOUT_MS = 500;
const INVALID_HANDLE = 0xffffffffffffffffn;
/** Windows SIDs render to at most a few dozen UTF-16 units; this is a hard bound. */
const SID_STRING_MAX_UNITS = 256;

/** Windows runtime check; injectable so the platform branch stays testable. */
export const isWindowsControlPlatform = (platform: string = process.platform): boolean =>
    platform === "win32";

/** Build the per-HerdR-session control pipe name from a 16 hex digit digest. */
export const windowsControlPipePath = (digest: string): string => {
    if (!HEX_DIGEST.test(digest)) {
        throw new RangeError(`Invalid control pipe digest: ${digest.slice(0, 32)}`);
    }
    return `${CONTROL_PIPE_PREFIX}${digest}`;
};

/** Named pipes are not filesystem paths; only the derived control name is accepted. */
export const isWindowsControlPipePath = (path: string): boolean => CONTROL_PIPE_PATTERN.test(path);

/**
 * Per-user Windows state root for the hook lock. Only `%LOCALAPPDATA%` and the
 * user profile are used; both are per-account locations with an inherited ACL
 * that grants the account control and does not grant other non-administrator
 * accounts write. There is deliberately no shared `%TEMP%` fallback: a shared
 * temp directory would let another account create or replace the lock file.
 * When neither variable is present the caller fails closed instead of guessing.
 *
 * This is the closest native analogue of a `0700` directory, but it is *not*
 * verified: `ensureWindowsStateDirectory` checks the path type only. See
 * `windows-lock.ts` for the identity checks that protect the lock file itself.
 */
export const windowsStateRoot = (environment: NodeJS.ProcessEnv): string | undefined => {
    const localAppData = environment.LOCALAPPDATA?.trim();
    if (localAppData !== undefined && localAppData.length > 0) {
        return join(resolve(localAppData), STATE_DIRECTORY_NAME);
    }
    const profile = environment.USERPROFILE?.trim();
    if (profile !== undefined && profile.length > 0) {
        return join(resolve(profile), "AppData", "Local", STATE_DIRECTORY_NAME);
    }
    return undefined;
};

/**
 * Hook startup lock for one control endpoint. The name is derived from the
 * endpoint so two HerdR sessions never share a lock, and the file lives in the
 * per-user state root so other users cannot create or replace it.
 */
export const windowsLockPath = (
    controlPath: string,
    environment: NodeJS.ProcessEnv,
): string | undefined => {
    const root = windowsStateRoot(environment);
    if (root === undefined) {
        return undefined;
    }
    const digest = createHash("sha256").update(controlPath).digest("hex").slice(0, 16);
    return join(root, LOCK_DIRECTORY_NAME, `${digest}.lock`);
};

/**
 * Create the lock directory and refuse to inherit an unexpected path type. The
 * directory inherits the ACL of the per-user state root; this function does not
 * read or verify that ACL, it only rejects a symlink or non-directory.
 */
export const ensureWindowsStateDirectory = async (directory: string): Promise<void> => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Refusing unsafe control state directory ${directory}`);
    }
};

export type WindowsPipePresence = "absent" | "present" | "occupied";

/**
 * Distinguish "free name", "our kind of listening pipe" and "something else
 * holds this name". A foreign pipe that never calls `ConnectNamedPipe` reports
 * `EBUSY`; probing it with `Bun.connect` would block until the client timeout,
 * so callers treat everything but `present` as unavailable.
 */
export const windowsPipePresence = async (path: string): Promise<WindowsPipePresence> => {
    try {
        await lstat(path);
        return "present";
    } catch (error) {
        if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
        ) {
            return "absent";
        }
        return "occupied";
    }
};

export type WindowsControlStartFailure = "already_running" | "occupied";

/**
 * Classify a failed `Bun.listen` on a named pipe without inventing success.
 *
 * `EADDRINUSE` (another Bun listener) and `EBUSY` (the name exists but no instance
 * is currently free) both mean the name is held by another instance, so callers
 * must neither start a second daemon nor unlink anything. Only a denial or an
 * unknown error is reported as occupied.
 */
export const classifyWindowsControlStartError = (error: unknown): WindowsControlStartFailure => {
    const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return code === "EADDRINUSE" || code === "EBUSY" ? "already_running" : "occupied";
};

const delay = (milliseconds: number): Promise<void> => {
    const { promise, resolve: resolveDelay } = Promise.withResolvers<void>();
    setTimeout(resolveDelay, milliseconds);
    return promise;
};

/**
 * Wait, bounded, until a freshly bound pipe is visible to `lstat`.
 *
 * The kernel occasionally reports a just-created instance as `EBUSY` (which
 * `windowsPipePresence` classifies as `occupied`), so a server that returned
 * before this wait could be reported as unavailable on the very next connect.
 * Resolving only once the name is present makes "server started" mean
 * "endpoint connectable" for callers in this and other processes.
 */
export const waitForWindowsPipeReady = async (
    path: string,
    timeoutMs = READY_TIMEOUT_MS,
): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if ((await windowsPipePresence(path)) === "present") {
            return true;
        }
        if (Date.now() >= deadline) {
            return false;
        }
        await delay(CLOSE_POLL_MS);
    }
};

/** Wait, bounded, for the kernel to drop a stopped pipe name. */
export const waitForWindowsPipeClosed = async (
    path: string,
    timeoutMs = CLOSE_TIMEOUT_MS,
): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if ((await windowsPipePresence(path)) === "absent") {
            return true;
        }
        if (Date.now() >= deadline) {
            return false;
        }
        await delay(CLOSE_POLL_MS);
    }
};

/**
 * Verdict for the account that owns the object behind a control pipe.
 *
 * - `own`: the pipe is owned by this process's Windows account.
 * - `foreign`: the pipe is owned by a different account and must be refused
 *   before any request bytes are written to it.
 * - `unverified`: the owner could not be read (native API unavailable), so the
 *   caller must fail closed.
 * - `unavailable`: no pipe could be opened at that name right now.
 */
export type WindowsPipeOwner = "own" | "foreign" | "unavailable" | "unverified";

/** Compare an object owner SID with the current account SID. Pure and testable. */
export const classifyWindowsPipeOwner = (
    ownerSid: string | undefined,
    userSid: string | undefined,
): WindowsPipeOwner => {
    if (ownerSid === undefined) {
        return "unavailable";
    }
    if (userSid === undefined) {
        return "unverified";
    }
    return ownerSid === userSid ? "own" : "foreign";
};

const CreateFileW = {
    args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
    ],
    returns: FFIType.ptr,
} as const;

const GetSecurityInfo = {
    args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
    ],
    returns: FFIType.u32,
} as const;

interface NativeSecurityApi {
    /** Open an existing named pipe read-attributes-only; `undefined` when absent. */
    readonly openPipe: (path: string) => Pointer | undefined;
    /** Owner SID of a kernel object handle. */
    readonly ownerSid: (handle: Pointer) => string | undefined;
    /** SID of the account running this process. */
    readonly currentUserSid: () => string | undefined;
}

let nativeSecurity: NativeSecurityApi | null | undefined;

/** Never a `boolean` on POSIX. Constant case labels keep the casts in one place. */
const INVALID_HANDLE_NUMBER = -1;

const asPointer = (value: number | bigint | null): Pointer | undefined => {
    // Bun returns a pointer as a branded number, or `0xffffffffffffffffn` for
    // `INVALID_HANDLE_VALUE`. Handle both without `BigInt(number)`, which throws.
    if (typeof value === "bigint") {
        // Bun reports `INVALID_HANDLE_VALUE` as an all-ones bigint; that is the
        // current-process pseudo-handle, not a pipe. Anything unrepresentable is
        // treated as invalid rather than truncated into a different handle.
        if (value === INVALID_HANDLE || value > BigInt(Number.MAX_SAFE_INTEGER)) {
            return undefined;
        }
        return Number(value) as Pointer;
    }
    if (value === null || value === INVALID_HANDLE_NUMBER || value === 0) {
        return undefined;
    }
    return value as Pointer;
};

const readWideString = (address: Pointer): string => {
    // `ConvertSidToStringSidW` allocates exactly the string plus its NUL; reading a
    // fixed 256-byte window would run past that allocation. Read one UTF-16 unit at
    // a time, bounded, and stop at the terminator.
    let text = "";
    for (let index = 0; index < SID_STRING_MAX_UNITS; index += 1) {
        const bytes = new Uint8Array(toArrayBuffer(address, index * 2, 2));
        const codeUnit = (bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8);
        if (codeUnit === 0) {
            break;
        }
        text += String.fromCharCode(codeUnit);
    }
    return text;
};

const loadNativeSecurity = (): NativeSecurityApi | null => {
    if (nativeSecurity !== undefined) {
        return nativeSecurity;
    }
    nativeSecurity = (() => {
        try {
            const kernel32 = dlopen("kernel32.dll", {
                CreateFileW,
                CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
                GetCurrentProcess: { args: [], returns: FFIType.ptr },
                LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
            });
            const advapi32 = dlopen("advapi32.dll", {
                GetSecurityInfo,
                OpenProcessToken: {
                    args: [FFIType.ptr, FFIType.u32, FFIType.ptr],
                    returns: FFIType.i32,
                },
                GetTokenInformation: {
                    args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr],
                    returns: FFIType.i32,
                },
                ConvertSidToStringSidW: {
                    args: [FFIType.ptr, FFIType.ptr],
                    returns: FFIType.i32,
                },
            });
            const sidToString = (sid: Pointer): string | undefined => {
                const out = new BigUint64Array(1);
                if (advapi32.symbols.ConvertSidToStringSidW(sid, ptr(out)) === 0) {
                    return undefined;
                }
                const address = read.ptr(ptr(out), 0);
                if (address === null) {
                    return undefined;
                }
                const rendered = readWideString(address as Pointer);
                kernel32.symbols.LocalFree(address as Pointer);
                return rendered.length > 0 ? rendered : undefined;
            };
            return {
                openPipe: (path) => {
                    // READ_CONTROL | FILE_READ_ATTRIBUTES, share read/write,
                    // OPEN_EXISTING. Overlapped avoids blocking on a pipe whose
                    // every instance is busy.
                    const name = Buffer.from(`${path}\u0000`, "utf16le");
                    return asPointer(
                        kernel32.symbols.CreateFileW(
                            ptr(name),
                            0x0002_0000 | 0x0000_0080,
                            0x0000_0003,
                            null,
                            3,
                            0x4000_0000,
                            null,
                        ) as number | bigint | null,
                    );
                },
                ownerSid: (handle) => {
                    // `(HANDLE)-1` is the current-process pseudo-handle: asking for
                    // its owner would "succeed" with our own SID. Never forward an
                    // invalid handle to `GetSecurityInfo`.
                    if ((handle as unknown as number) === INVALID_HANDLE_NUMBER) {
                        return undefined;
                    }
                    const owner = new BigUint64Array(1);
                    const descriptor = new BigUint64Array(1);
                    let descriptorAddress: Pointer | undefined;
                    try {
                        // SE_KERNEL_OBJECT + OWNER_SECURITY_INFORMATION. The
                        // descriptor is allocated by the API and must be released
                        // with `LocalFree` before the handle is closed.
                        const status = advapi32.symbols.GetSecurityInfo(
                            handle,
                            6,
                            0x0000_0001,
                            ptr(owner),
                            null,
                            null,
                            null,
                            ptr(descriptor),
                        );
                        if (status !== 0) {
                            return undefined;
                        }
                        descriptorAddress = asPointer(read.ptr(ptr(descriptor), 0));
                        const sid = read.ptr(ptr(owner), 0);
                        if (sid === null) {
                            return undefined;
                        }
                        return sidToString(sid as Pointer);
                    } finally {
                        if (descriptorAddress !== undefined) {
                            kernel32.symbols.LocalFree(descriptorAddress);
                        }
                        kernel32.symbols.CloseHandle(handle as Pointer);
                    }
                },
                currentUserSid: () => {
                    const token = new BigUint64Array(1);
                    if (
                        advapi32.symbols.OpenProcessToken(
                            kernel32.symbols.GetCurrentProcess(),
                            0x0000_0008,
                            ptr(token),
                        ) === 0
                    ) {
                        return undefined;
                    }
                    const tokenHandle = read.ptr(ptr(token), 0);
                    if (tokenHandle === null) {
                        return undefined;
                    }
                    try {
                        // TokenUser: the SID pointer occupies the first 8 bytes.
                        // A BigUint64Array keeps the buffer 8-byte aligned, which
                        // a struct with pointer fields requires.
                        const buffer = new BigUint64Array(32);
                        const needed = new Uint32Array(1);
                        if (
                            advapi32.symbols.GetTokenInformation(
                                tokenHandle,
                                1,
                                ptr(buffer),
                                buffer.byteLength,
                                ptr(needed),
                            ) === 0
                        ) {
                            return undefined;
                        }
                        const sid = read.ptr(ptr(buffer), 0);
                        if (sid === null) {
                            return undefined;
                        }
                        return sidToString(sid as Pointer);
                    } finally {
                        kernel32.symbols.CloseHandle(tokenHandle as Pointer);
                    }
                },
            };
        } catch {
            return null;
        }
    })();
    return nativeSecurity;
};

let memoisedUserSid: string | undefined | null;

/** SID of the account running this process, or `undefined` if it cannot be read. */
export const currentWindowsUserSid = (): string | undefined => {
    if (memoisedUserSid !== null && memoisedUserSid !== undefined) {
        return memoisedUserSid;
    }
    const api = loadNativeSecurity();
    memoisedUserSid = api?.currentUserSid() ?? null;
    return memoisedUserSid ?? undefined;
};

/** Owner SID of the pipe currently holding `path`, without writing to it. */
export const windowsPipeOwnerSid = (path: string): string | undefined => {
    const api = loadNativeSecurity();
    if (api === null) {
        return undefined;
    }
    const handle = api.openPipe(path);
    if (handle === undefined) {
        return undefined;
    }
    return api.ownerSid(handle);
};

/**
 * Verify that the pipe at `path` belongs to the current account before the
 * client writes a request into it. Bun cannot report a pipe's peer owner, so the
 * object owner is read through `CreateFileW` + `GetSecurityInfo` instead.
 * `userSid` is injectable so the comparison itself is testable.
 */
export const windowsPipeOwner = (path: string, userSid?: string): WindowsPipeOwner =>
    classifyWindowsPipeOwner(
        windowsPipeOwnerSid(path),
        userSid === undefined ? currentWindowsUserSid() : userSid,
    );
