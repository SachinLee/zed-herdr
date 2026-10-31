import { homedir, tmpdir } from "node:os";

/**
 * Windows endpoint derivation for the HerdR socket API.
 *
 * HerdR uses one filesystem "socket path" on every platform. On Unix that path is a
 * Unix-domain socket; on Windows it is a regular marker file (contents `<pid>:<nanos>`)
 * and the addressable object is a named pipe named `\\.\pipe\<socket path>`.
 *
 * The path is taken verbatim: HerdR passes `path.to_string_lossy()` to `interprocess`'s
 * `GenericNamespaced` name type, which only prepends `\\.\pipe\` (herdr v0.9.5
 * `src/ipc.rs` `bind_local_listener`). Backslashes and the drive colon are therefore
 * literal characters of the pipe name, not namespace separators.
 */

/** Mandatory prefix of every HerdR named pipe; the socket path follows verbatim. */
export const HERDR_NAMED_PIPE_PREFIX = "\\\\.\\pipe\\";

/** The `herdr` configuration directory name HerdR uses for release builds. */
export const HERDR_CONFIG_DIRECTORY_NAME = "herdr";

const WINDOWS_SEPARATOR_ENDING = /[\\/]$/u;

/** Appends path segments while preserving the base spelling HerdR would echo. */
const appendWindowsSegments = (base: string, ...segments: ReadonlyArray<string>): string => {
    let resolved = base;
    for (const segment of segments) {
        if (!WINDOWS_SEPARATOR_ENDING.test(resolved)) {
            resolved += "\\";
        }
        resolved += segment;
    }
    return resolved;
};

/**
 * Mirrors HerdR's `config_dir()`/`platform_config_dir()` on Windows: `XDG_CONFIG_HOME`
 * wins when set, then `%APPDATA%`, then `%USERPROFILE%\AppData\Roaming`, then
 * `$HOME/.config`, then the temporary directory.
 */
const resolveWindowsConfigDirectory = (environment: NodeJS.ProcessEnv): string => {
    const xdgConfigHome = environment.XDG_CONFIG_HOME;
    if (xdgConfigHome !== undefined && xdgConfigHome.length > 0) {
        return appendWindowsSegments(xdgConfigHome, HERDR_CONFIG_DIRECTORY_NAME);
    }

    const appData = environment.APPDATA;
    if (appData !== undefined && appData.length > 0) {
        return appendWindowsSegments(appData, HERDR_CONFIG_DIRECTORY_NAME);
    }

    const userProfile = environment.USERPROFILE;
    if (userProfile !== undefined && userProfile.length > 0) {
        return appendWindowsSegments(
            userProfile,
            "AppData",
            "Roaming",
            HERDR_CONFIG_DIRECTORY_NAME,
        );
    }

    const home = environment.HOME;
    if (home !== undefined && home.length > 0) {
        return appendWindowsSegments(home, ".config", HERDR_CONFIG_DIRECTORY_NAME);
    }

    return appendWindowsSegments(tmpdir(), HERDR_CONFIG_DIRECTORY_NAME);
};

/**
 * Resolves the Windows HerdR marker-file path without probing or mutating anything.
 * `HERDR_SOCKET_PATH` is used verbatim; `HERDR_SESSION` selects `sessions/<name>`.
 */
export const resolveHerdRWindowsSocketPath = (environment: NodeJS.ProcessEnv): string => {
    const configuredSocket = environment.HERDR_SOCKET_PATH;
    if (configuredSocket !== undefined && configuredSocket.length > 0) {
        return configuredSocket;
    }

    const configDirectory = resolveWindowsConfigDirectory(environment);
    const session = environment.HERDR_SESSION;
    const dataDirectory =
        session !== undefined && session.length > 0
            ? appendWindowsSegments(configDirectory, "sessions", session)
            : configDirectory;

    return appendWindowsSegments(dataDirectory, "herdr.sock");
};

const resolvePosixHerdRSocketPath = (environment: NodeJS.ProcessEnv): string => {
    const configuredSocket = environment.HERDR_SOCKET_PATH;
    if (configuredSocket !== undefined && configuredSocket.length > 0) {
        return configuredSocket;
    }

    const configHome =
        environment.XDG_CONFIG_HOME && environment.XDG_CONFIG_HOME.length > 0
            ? environment.XDG_CONFIG_HOME
            : `${environment.HOME ?? homedir()}/.config`;
    const session = environment.HERDR_SESSION;

    return session !== undefined && session.length > 0
        ? `${configHome}/herdr/sessions/${session}/herdr.sock`
        : `${configHome}/herdr/herdr.sock`;
};

/** Resolve HerdR's socket path without probing or mutating the filesystem. */
export const resolveHerdRSocketPath = (
    environment: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
): string =>
    platform === "win32"
        ? resolveHerdRWindowsSocketPath(environment)
        : resolvePosixHerdRSocketPath(environment);

/**
 * Converts a HerdR socket path into its Windows named-pipe name. The path is kept
 * verbatim; setting `HERDR_SOCKET_PATH` to an already-prefixed pipe would double it.
 */
export const toHerdRNamedPipePath = (socketPath: string): string => {
    if (socketPath.length === 0) {
        throw new TypeError("HerdR socket path must not be empty");
    }
    if (socketPath.includes("\0")) {
        throw new RangeError("HerdR socket path must not contain a NUL character");
    }

    return `${HERDR_NAMED_PIPE_PREFIX}${socketPath}`;
};

/** A minimal byte channel: the only capabilities the NDJSON client needs. */
export interface HerdRChannel {
    readonly write: (data: string) => void;
    readonly terminate: () => void;
}

export interface HerdRChannelHandlers {
    readonly data: (chunk: Uint8Array) => void;
    readonly close: (error: Error | null) => void;
    readonly end: () => void;
    readonly error: (error: Error) => void;
}

const errorCode = (cause: unknown): string =>
    typeof cause === "object" && cause !== null && "code" in cause
        ? String((cause as { readonly code: unknown }).code)
        : "ERR_HERDR_CONNECT";

/** Adds the pipe name and HerdR's own remediation hint to a Windows connect failure. */
const describeWindowsConnectError = (socketPath: string, cause: unknown): Error =>
    new Error(
        errorCode(cause) === "EACCES" || errorCode(cause) === "EPERM"
            ? `HerdR named pipe access denied: ${toHerdRNamedPipePath(socketPath)}. For an elevated server, use an administrator terminal. Sharing with ordinary clients requires stopping it there and restarting its \`herdr server\` command with --allow-unelevated-clients (closes panes).`
            : `HerdR named pipe unavailable: ${toHerdRNamedPipePath(socketPath)} (${errorCode(cause)}). Check that HerdR is running and that HERDR_SOCKET_PATH matches this process.`,
        { cause },
    );

/**
 * Opens one short-lived connection to HerdR. Windows connects through the derived named
 * pipe; every other platform keeps the existing Unix-domain socket behaviour.
 */
export const connectHerdRChannel = (
    socketPath: string,
    handlers: HerdRChannelHandlers,
    platform: NodeJS.Platform = process.platform,
): Promise<HerdRChannel> => {
    const isWindows = platform === "win32";
    const target = isWindows ? toHerdRNamedPipePath(socketPath) : socketPath;

    return Bun.connect({
        unix: target,
        socket: {
            binaryType: "uint8array",
            data: (_socket, chunk) => handlers.data(chunk),
            close: (_socket, error) => handlers.close(error ?? null),
            end: () => handlers.end(),
            error: (_socket, error) => handlers.error(error),
        },
    }).then(
        (socket): HerdRChannel => ({
            terminate: () => socket.terminate(),
            write: (data: string) => {
                socket.write(data);
            },
        }),
        (cause: unknown) => {
            throw isWindows ? describeWindowsConnectError(socketPath, cause) : cause;
        },
    );
};
