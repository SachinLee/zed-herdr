import { resolve } from "node:path";

/**
 * Internal marker that selects the file log backend. It is not user-facing
 * configuration: only the background spawn path sets it.
 */
export const BACKGROUND_DAEMON_MARKER = "ZED_HERDR_BACKGROUND";

const ENTRY_FALLBACK = "index.ts";

export interface BackgroundDaemonLaunch {
    readonly cmd: ReadonlyArray<string>;
    readonly env: Record<string, string>;
    readonly detached: true;
    readonly windowsHide: true;
    readonly stdin: "ignore";
    readonly stdout: "ignore";
    readonly stderr: "ignore";
}

export interface BackgroundDaemon {
    readonly pid: number;
    readonly exited: Promise<number>;
    readonly kill: (signal?: NodeJS.Signals | number) => void;
}

/** Start one detached daemon process; injected so tests never fork. */
export type DaemonSpawner = (environment: NodeJS.ProcessEnv) => BackgroundDaemon;

/**
 * Absolute path of the module the daemon runs from. `Bun.main` is the entry
 * module of the running bundle, so a source daemon reuses the source entry and
 * a built daemon reuses `dist/index.js`.
 */
export const daemonEntryPoint = (): string => {
    const main = Bun.main;
    const candidate = main.length > 0 ? main : (process.argv[1] ?? ENTRY_FALLBACK);
    return resolve(candidate);
};

/**
 * Describe the detached daemon launch. The daemon must own no HerdR pane, so
 * the hook's pane identity is stripped: a background daemon reports no pane.
 */
export const daemonLaunch = (
    environment: NodeJS.ProcessEnv,
    entry: string = daemonEntryPoint(),
): BackgroundDaemonLaunch => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(environment)) {
        if (value !== undefined) {
            env[key] = value;
        }
    }
    delete env.HERDR_PANE_ID;
    env[BACKGROUND_DAEMON_MARKER] = "1";

    return {
        cmd: [process.execPath, entry, "daemon"],
        env,
        detached: true,
        windowsHide: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
    };
};

/** Spawn exactly the launch described above, without a shell or a cwd change. */
export const spawnDetached = (launch: BackgroundDaemonLaunch): BackgroundDaemon => {
    const child = Bun.spawn({
        cmd: [...launch.cmd],
        env: launch.env,
        detached: launch.detached,
        windowsHide: launch.windowsHide,
        stdin: launch.stdin,
        stdout: launch.stdout,
        stderr: launch.stderr,
    });
    child.unref();

    return {
        pid: child.pid,
        exited: child.exited,
        kill: (signal) => {
            try {
                child.kill(signal ?? "SIGKILL");
            } catch {
                // The child may have exited between the readiness check and the kill.
            }
        },
    };
};

export const spawnBackgroundDaemon: DaemonSpawner = (environment) =>
    spawnDetached(daemonLaunch(environment));
