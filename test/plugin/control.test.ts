import { expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { runCli } from "../../src/cli.ts";
import {
    CONTROL_DAEMON_IDENTITY,
    controlLockPath,
    controlSocketPath,
    notifyControl,
    prepareControlSocketDirectory,
    startControlServer,
} from "../../src/plugin/control.ts";
import type { ControlServer } from "../../src/plugin/control.ts";
import { runHook } from "../../src/plugin/hook.ts";
import { HealthControlResponse, HookNotification } from "../../src/plugin/protocol.ts";
import { isWindowsControlPlatform, windowsPipePresence } from "../../src/plugin/windows-pipe.ts";

interface CliObservation {
    readonly exitCode: typeof process.exitCode;
    readonly stderr: ReadonlyArray<string>;
    readonly stdout: ReadonlyArray<string>;
}

interface IsolatedCliObservation {
    readonly exitCode: number;
    readonly stderr: string;
    readonly stdout: string;
}

const makeTemporaryDirectory = (): Promise<string> =>
    mkdtemp(join(tmpdir(), "zed-herdr-control-integration-"));

const controlEnvironment = (
    herdrSocket: string,
    overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv => ({
    HERDR_SOCKET_PATH: herdrSocket,
    // Windows derives both the pipe name and the hook lock path from the
    // per-account state root, exactly as a real daemon invocation would.
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    USERPROFILE: process.env.USERPROFILE,
    ...overrides,
});

const hookEnvironment = (herdrSocket: string): NodeJS.ProcessEnv => ({
    ...controlEnvironment(herdrSocket),
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
        data: { workspace: { workspace_id: "integration-workspace" } },
    }),
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: "/repo/integration" }),
});

const createOrphanedSocket = async (path: string): Promise<void> => {
    await prepareControlSocketDirectory(path);
    const child = Bun.spawn({
        cmd: [
            process.execPath,
            "-e",
            [
                "const listener = Bun.listen({ unix: process.argv[1], socket: { data() {} } });",
                'console.log("ready");',
                "process.stdin.resume();",
            ].join(" "),
            path,
        ],
        stderr: "pipe",
        stdout: "pipe",
    });
    const reader = child.stdout.getReader();

    try {
        const { done, value } = await reader.read();
        if (done || value === undefined) {
            throw new Error("orphan socket listener exited before readiness");
        }
        expect(new TextDecoder().decode(value).trim()).toBe("ready");
    } finally {
        child.kill("SIGKILL");
        await child.exited;
    }

    if (isWindowsControlPlatform()) {
        // A named pipe belongs to the kernel: terminating the owner removes the
        // name, so a Windows "orphan" is simply an absent endpoint.
        expect(await windowsPipePresence(path)).toBe("absent");
        return;
    }

    const uid = process.getuid?.();
    if (uid === undefined) {
        throw new Error("control sockets require a POSIX uid");
    }
    const stat = await lstat(path);
    expect(stat.isSocket()).toBe(true);
    expect(stat.uid).toBe(uid);
};

const runControlCli = async (
    command: "health" | "stop" | "toggle",
    environment: NodeJS.ProcessEnv,
): Promise<CliObservation> => {
    const originalLog = console.log;
    const originalError = console.error;
    const originalExitCode = process.exitCode;
    const stdout: Array<string> = [];
    const stderr: Array<string> = [];

    console.log = (...values: Array<unknown>) => {
        stdout.push(values.map(String).join(" "));
    };
    console.error = (...values: Array<unknown>) => {
        stderr.push(values.map(String).join(" "));
    };

    try {
        process.exitCode = undefined;
        await Effect.runPromise(runCli([command], environment));
        return { exitCode: process.exitCode, stderr, stdout };
    } finally {
        console.log = originalLog;
        console.error = originalError;
        process.exitCode = originalExitCode;
    }
};

const runIsolatedControlCli = async (
    command: "health" | "stop" | "toggle",
    herdrSocket: string,
): Promise<IsolatedCliObservation> => {
    const child = Bun.spawn({
        cmd: [process.execPath, "index.ts", command],
        env: { ...process.env, HERDR_SOCKET_PATH: herdrSocket },
        stderr: "pipe",
        stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    return { exitCode, stderr, stdout };
};

const runIsolatedHealthCli = async (herdrSocket: string): Promise<IsolatedCliObservation> =>
    runIsolatedControlCli("health", herdrSocket);

test("health and toggle CLIs control the real daemon and reject absent health sockets", async () => {
    const directory = await makeTemporaryDirectory();
    const herdrSocket = join(directory, "herdr.sock");
    const path = controlSocketPath(controlEnvironment(herdrSocket));
    let server: ControlServer | undefined;

    try {
        let enabled = true;
        const started = await startControlServer({
            path,
            paneId: "injected-daemon-pane",
            notifications: { async publish() {} },
            toggleEnabled() {
                enabled = !enabled;
                return enabled;
            },
        });
        server = started;

        const healthy = await runControlCli("health", controlEnvironment(herdrSocket));
        const expectedResponse = { ok: true as const, daemon: started.daemon };
        expect(healthy.exitCode).toBeUndefined();
        expect(healthy.stderr).toEqual([]);
        expect(healthy.stdout).toEqual([JSON.stringify(expectedResponse)]);
        const response = Schema.decodeUnknownSync(HealthControlResponse)(
            JSON.parse(healthy.stdout[0] ?? ""),
        );
        expect(response).toEqual(expectedResponse);
        expect(response.daemon.identity).toBe(CONTROL_DAEMON_IDENTITY);
        expect(response.daemon.paneId).toBe("injected-daemon-pane");

        const toggled = await runControlCli("toggle", controlEnvironment(herdrSocket));
        expect(toggled.exitCode).toBeUndefined();
        expect(toggled.stderr).toEqual([]);
        expect(toggled.stdout).toEqual([JSON.stringify({ ok: true, enabled: false })]);

        await server.close();
        server = undefined;

        const absent = await runIsolatedHealthCli(herdrSocket);
        expect(absent.exitCode).toBe(1);
        expect(absent.stdout).toBe("");

        if (isWindowsControlPlatform()) {
            // A filesystem write cannot occupy a pipe name; the Windows analogue
            // of a foreign endpoint is a listener that answers with garbage.
            const squatter = Bun.listen({
                unix: path,
                socket: {
                    data(socket) {
                        socket.end("{}\n");
                    },
                },
            });
            try {
                const invalid = await runIsolatedHealthCli(herdrSocket);
                expect(invalid.exitCode).toBe(1);
                expect(invalid.stdout).toBe("");
            } finally {
                squatter.stop(true);
            }
        } else {
            await writeFile(path, "not a socket", { mode: 0o600 });
            const invalid = await runIsolatedHealthCli(herdrSocket);
            expect(invalid.exitCode).toBe(1);
            expect(invalid.stdout).toBe("");
        }
    } finally {
        await server?.close();
        await rm(path, { force: true });
        await rm(directory, { force: true, recursive: true });
    }
}, 3_000);

test("direct daemon startup replaces an orphaned socket and cleans its bound inode", async () => {
    const directory = await makeTemporaryDirectory();
    const herdrSocket = join(directory, "herdr.sock");
    const path = controlSocketPath(controlEnvironment(herdrSocket));
    let server: ControlServer | undefined;

    try {
        await createOrphanedSocket(path);
        server = await startControlServer({
            path,
            paneId: null,
            notifications: { async publish() {} },
        });

        if (isWindowsControlPlatform()) {
            expect(await windowsPipePresence(path)).toBe("present");
        } else {
            const bound = await lstat(path);
            expect(bound.isSocket()).toBe(true);
        }
        expect(
            await readFile(controlLockPath(path, controlEnvironment(herdrSocket)), "utf8").catch(
                () => undefined,
            ),
        ).toBeUndefined();

        await server.close();
        server = undefined;
        if (isWindowsControlPlatform()) {
            expect(await windowsPipePresence(path)).toBe("absent");
        } else {
            await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
        }
    } finally {
        await server?.close();
        await rm(path, { force: true });
        await rm(directory, { force: true, recursive: true });
    }
}, 3_000);

test("hook recovers an orphan, opens one daemon, waits for readiness, and publishes its cwd hint", async () => {
    const directory = await makeTemporaryDirectory();
    const herdrSocket = join(directory, "herdr.sock");
    const environment = hookEnvironment(herdrSocket);
    const path = controlSocketPath(environment);
    const notifications: Array<HookNotification> = [];
    let starts = 0;
    let server: ControlServer | undefined;

    try {
        await createOrphanedSocket(path);

        const result = await runHook({
            environment,
            spawnDaemon: () => {
                starts += 1;
                void startControlServer({
                    path,
                    paneId: null,
                    notifications: {
                        async publish(notification) {
                            notifications.push(notification);
                        },
                    },
                }).then((created) => {
                    server = created;
                });
                return {
                    pid: 42,
                    exited: new Promise<number>(() => undefined),
                    kill: () => undefined,
                };
            },
        });

        expect(result).toEqual({ _tag: "Notified", startedDaemon: true });
        expect(starts).toBe(1);
        expect(notifications).toEqual([
            Schema.decodeUnknownSync(HookNotification)({
                workspaceId: "integration-workspace",
                cwd: "/repo/integration",
            }),
        ]);
        await expect(readFile(controlLockPath(path, environment), "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
    } finally {
        await server?.close();
        await unlink(controlLockPath(path, environment)).catch(() => undefined);
        await rm(path, { force: true });
        await rm(directory, { force: true, recursive: true });
    }
}, 3_000);

test("buffers a control notification received before hint stream consumption", async () => {
    const directory = await makeTemporaryDirectory();
    const herdrSocket = join(directory, "herdr.sock");
    const path = controlSocketPath(controlEnvironment(herdrSocket));
    const queue = await Effect.runPromise(Queue.unbounded<HookNotification>());
    let server: ControlServer | undefined;

    try {
        server = await startControlServer({
            path,
            paneId: null,
            notifications: {
                async publish(notification) {
                    await Effect.runPromise(Queue.offer(queue, notification).pipe(Effect.asVoid));
                },
            },
        });

        const notification = Schema.decodeUnknownSync(HookNotification)({
            workspaceId: "early-workspace",
            cwd: "/repo/early",
        });
        await notifyControl(path, notification);

        let received: HookNotification | undefined;
        await Effect.runPromise(
            Stream.runForEach(Stream.fromQueue(queue).pipe(Stream.take(1)), (hint) =>
                Effect.sync(() => {
                    received = hint;
                }),
            ),
        );
        expect(received).toEqual(notification);
    } finally {
        await server?.close();
        await Effect.runPromise(Queue.shutdown(queue));
        await rm(path, { force: true });
        await rm(directory, { force: true, recursive: true });
    }
});

test("stop CLI shuts down the matching daemon and reports an absent endpoint", async () => {
    const directory = await makeTemporaryDirectory();
    const herdrSocket = join(directory, "herdr.sock");
    const path = controlSocketPath(controlEnvironment(herdrSocket));
    let server: ControlServer | undefined;
    let stops = 0;

    try {
        server = await startControlServer({
            path,
            paneId: "injected-daemon-pane",
            notifications: { async publish() {} },
            stopRequested() {
                stops += 1;
                void server?.close();
            },
        });
        const expected = server.daemon;

        const stopped = await runControlCli("stop", controlEnvironment(herdrSocket));
        expect(stopped.exitCode).toBeUndefined();
        expect(stopped.stderr).toEqual([]);
        expect(stopped.stdout).toEqual([JSON.stringify({ ok: true, daemon: expected })]);
        expect(stops).toBe(1);
        if (isWindowsControlPlatform()) {
            expect(await windowsPipePresence(path)).toBe("absent");
        } else {
            await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
        }

        // A second stop finds nothing to stop and never starts a daemon. The
        // non-zero exit is observed in a child process so the suite's own
        // `process.exitCode` is never pinned by a failed command.
        const absent = await runIsolatedControlCli("stop", herdrSocket);
        expect(absent.exitCode).toBe(1);
        expect(absent.stdout).toBe("");
        expect(absent.stderr.trim().length).toBeGreaterThan(0);
        expect(stops).toBe(1);
    } finally {
        await server?.close();
        await rm(path, { force: true });
        await rm(directory, { force: true, recursive: true });
    }
}, 3_000);
