import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
    decodeHookNotification,
    ensureDaemon,
    HookStartupError,
    runHook,
} from "../../src/plugin/hook.ts";
import type { HookControlApi } from "../../src/plugin/hook.ts";
import type { BackgroundDaemon, DaemonSpawner } from "../../src/plugin/daemon-process.ts";
import { preflightDaemonLog } from "../../src/plugin/daemon-log.ts";
import {
    CONTROL_DAEMON_IDENTITY,
    ControlProtocolError,
    ControlUnavailable,
    UnsafeControlSocket,
    controlLockPath,
} from "../../src/plugin/control.ts";
import type { DaemonHealth, HookNotification } from "../../src/plugin/protocol.ts";
import { isWindowsControlPlatform } from "../../src/plugin/windows-pipe.ts";

const posixTest = test.skipIf(isWindowsControlPlatform());

const expectNotification = (
    notification: HookNotification | undefined,
    workspaceId: string,
    cwd: string,
): void => {
    expect(
        notification?.workspaceId === undefined ? undefined : String(notification.workspaceId),
    ).toBe(workspaceId);
    expect(notification?.cwd).toBe(cwd);
};

const hookEnvironment = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    // Windows derives the hook lock file from the per-account state root, so the
    // test environment must carry the same profile variables a real hook sees.
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    USERPROFILE: process.env.USERPROFILE,
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
        data: { workspace: { workspace_id: "event-workspace" } },
    }),
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: "/repos/event" }),
    HERDR_WORKSPACE_ID: "environment-workspace",
    ...overrides,
});
const temporaryDirectory = (): Promise<string> => mkdtemp(join(tmpdir(), "zed-herdr-hook-"));

const unavailable = async (): Promise<void> => {
    throw new ControlUnavailable("/control.sock", "connect");
};

const daemonHealth = (): DaemonHealth => ({
    identity: CONTROL_DAEMON_IDENTITY,
    paneId: null,
    pid: 4_242,
    startedAt: "2026-01-01T00:00:00.000Z",
    protocol: null,
    beyondTested: false,
});

const unavailableHealth: HookControlApi["healthControl"] = async (path) => {
    throw new ControlUnavailable(path, "connect");
};

const controlFor = (
    path: string,
    notify: HookControlApi["notifyControl"],
    prepare: HookControlApi["prepareControlSocket"] = async () => undefined,
    prepareDirectory: HookControlApi["prepareControlSocketDirectory"] = async () => undefined,
    health: HookControlApi["healthControl"] = unavailableHealth,
): HookControlApi => ({
    controlSocketPath: () => path,
    healthControl: health,
    notifyControl: notify,
    prepareControlSocket: prepare,
    prepareControlSocketDirectory: prepareDirectory,
});

const neverExits = (): Promise<number> => new Promise<number>(() => undefined);

const daemonFor = (
    options: { readonly exit?: Promise<number>; readonly kill?: () => void } = {},
): BackgroundDaemon => ({
    pid: 4_242,
    exited: options.exit ?? neverExits(),
    kill: options.kill ?? (() => undefined),
});

const spawnFor =
    (callback: () => void = () => undefined): DaemonSpawner =>
    () => {
        callback();
        return daemonFor();
    };

/** Bind the hook lock and daemon log to the test directory on every platform. */
const hookEnvironmentFor = (
    directory: string,
    overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv =>
    hookEnvironment({ LOCALAPPDATA: directory, USERPROFILE: directory, ...overrides });

test("declares the official HerdR v0.7.3 plugin manifest", async () => {
    const manifest = await readFile(join(import.meta.dir, "../../herdr-plugin.toml"), "utf8");

    expect(Bun.TOML.parse(manifest)).toEqual({
        id: "artisann.zed-herdr",
        name: "Zed Workspace Sync",
        version: "0.1.0",
        min_herdr_version: "0.7.3",
        platforms: ["macos", "linux", "windows"],
        build: [
            { command: ["bun", "install", "--frozen-lockfile"] },
            { command: ["bun", "run", "build"] },
        ],
        actions: [
            {
                id: "toggle",
                title: "Toggle Zed Workspace Sync",
                contexts: ["workspace"],
                command: ["bun", "./dist/index.js", "toggle"],
            },
        ],
        events: [
            { on: "workspace.created", command: ["bun", "./dist/index.js", "hook"] },
            { on: "workspace.focused", command: ["bun", "./dist/index.js", "hook"] },
        ],
    });
});

test("uses documented event workspace payloads before HERDR_WORKSPACE_ID and context cwd", async () => {
    expectNotification(
        decodeHookNotification(hookEnvironment()),
        "event-workspace",
        "/repos/event",
    );
    expectNotification(
        decodeHookNotification(
            hookEnvironment({
                HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
                    data: { workspace_id: "focused-workspace" },
                }),
                HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: "/repos/focused" }),
            }),
        ),
        "focused-workspace",
        "/repos/focused",
    );
    expectNotification(
        decodeHookNotification(
            hookEnvironment({
                HERDR_PLUGIN_EVENT_JSON: "{}",
                HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: "/repos/context" }),
            }),
        ),
        "environment-workspace",
        "/repos/context",
    );
    expect(
        decodeHookNotification(
            hookEnvironment({
                HERDR_PLUGIN_CONTEXT_JSON: "{}",
                PWD: "/must-not-be-used",
            }),
        ),
    ).toBeUndefined();
});

test("rejects invalid or incomplete event and context hook payload schemas", async () => {
    const environmentWithoutFallback = {
        ...hookEnvironment(),
        HERDR_WORKSPACE_ID: undefined,
    };

    for (const environment of [
        {
            ...environmentWithoutFallback,
            HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ data: { workspace_id: 1 } }),
        },
        {
            ...environmentWithoutFallback,
            HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ data: {} }),
        },
        {
            ...environmentWithoutFallback,
            HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
                data: { workspace: { workspace_id: "" } },
            }),
        },
        {
            ...environmentWithoutFallback,
            HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: "" }),
        },
        {
            ...environmentWithoutFallback,
            HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({}),
        },
    ]) {
        expect(decodeHookNotification(environment)).toBeUndefined();
    }
});

test("notifies an existing daemon without starting another one", async () => {
    const directory = await temporaryDirectory();
    try {
        const notifications: Array<unknown> = [];
        let starts = 0;
        const result = await runHook({
            control: controlFor(
                join(directory, "control.sock"),
                async (_path, notification) => {
                    notifications.push(notification);
                },
                undefined,
                undefined,
                async () => daemonHealth(),
            ),
            environment: hookEnvironmentFor(directory),
            spawnDaemon: spawnFor(() => {
                starts += 1;
            }),
        });

        expect(result).toEqual({ _tag: "Notified", startedDaemon: false });
        expect(starts).toBe(0);
        expect(notifications).toEqual([{ workspaceId: "event-workspace", cwd: "/repos/event" }]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("bounds a stalled existing control socket within the single hook deadline", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "control.sock");
        const timeouts: Array<number | undefined> = [];
        let now = 0;
        let starts = 0;
        const control = controlFor(
            path,
            unavailable,
            undefined,
            undefined,
            async (target, timeoutMs) => {
                timeouts.push(timeoutMs);
                now += timeoutMs ?? 0;
                throw new ControlUnavailable(target, "timeout");
            },
        );

        await expect(
            runHook({
                control,
                environment: hookEnvironmentFor(directory),
                now: () => now,
                spawnDaemon: spawnFor(() => {
                    starts += 1;
                }),
            }),
        ).rejects.toMatchObject({ _tag: "HookStartupError", operation: "readiness" });
        expect(timeouts).toEqual([1_500]);
        expect(starts).toBe(0);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("does not spawn a daemon after the shared deadline expires", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "control.sock");
        let now = 0;
        let probes = 0;
        let starts = 0;
        let notifications = 0;
        const control = controlFor(
            path,
            async () => {
                notifications += 1;
                await unavailable();
            },
            undefined,
            undefined,
            async (target) => {
                probes += 1;
                if (probes === 2) {
                    now = 1_500;
                }
                throw new ControlUnavailable(target, "connect");
            },
        );

        await expect(
            runHook({
                control,
                environment: hookEnvironmentFor(directory),
                now: () => now,
                spawnDaemon: spawnFor(() => {
                    starts += 1;
                }),
            }),
        ).rejects.toMatchObject({ _tag: "HookStartupError", operation: "readiness" });
        expect(probes).toBe(2);
        expect(notifications).toBe(0);
        expect(starts).toBe(0);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("propagates protocol and unsafe control errors without retrying or spawning", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "control.sock");
        for (const failure of [
            new ControlProtocolError(path, "malformed response"),
            new UnsafeControlSocket(path, "unsafe_mode"),
        ]) {
            let probes = 0;
            let starts = 0;

            await expect(
                runHook({
                    control: controlFor(
                        path,
                        async () => {
                            throw failure;
                        },
                        undefined,
                        undefined,
                        async () => {
                            probes += 1;
                            throw failure;
                        },
                    ),
                    environment: hookEnvironmentFor(directory),
                    spawnDaemon: spawnFor(() => {
                        starts += 1;
                    }),
                }),
            ).rejects.toBe(failure);
            expect(probes).toBe(1);
            expect(starts).toBe(0);
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("rejects an unsafe control parent before probing or starting a daemon", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "control.sock");
        const failure = new UnsafeControlSocket(path, "unsafe_parent");
        let directoryPreparations = 0;
        let probes = 0;
        let starts = 0;

        await expect(
            runHook({
                control: controlFor(
                    path,
                    async () => {
                        throw new ControlUnavailable(path, "connect");
                    },
                    async () => undefined,
                    async () => {
                        directoryPreparations += 1;
                        throw failure;
                    },
                    async () => {
                        probes += 1;
                        return daemonHealth();
                    },
                ),
                environment: hookEnvironmentFor(directory),
                spawnDaemon: spawnFor(() => {
                    starts += 1;
                }),
            }),
        ).rejects.toBe(failure);
        expect(directoryPreparations).toBe(1);
        expect(probes).toBe(0);
        expect(starts).toBe(0);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("starts exactly one detached daemon while twenty hooks contend", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "control.sock");
        const spawning = Promise.withResolvers<void>();
        const notifications: Array<unknown> = [];
        let ready = false;
        let starts = 0;
        const control = controlFor(
            path,
            async (_path, notification) => {
                if (!ready) {
                    await unavailable();
                }
                notifications.push(notification);
            },
            undefined,
            undefined,
            async (target) => {
                if (!ready) {
                    throw new ControlUnavailable(target, "connect");
                }
                return daemonHealth();
            },
        );

        const runs = Array.from({ length: 20 }, () =>
            runHook({
                control,
                environment: hookEnvironmentFor(directory, { HERDR_SESSION: "work" }),
                spawnDaemon: () => {
                    starts += 1;
                    spawning.resolve();
                    return daemonFor();
                },
            }),
        );
        await spawning.promise;
        ready = true;

        expect(await Promise.all(runs)).toHaveLength(20);
        expect(starts).toBe(1);
        expect(notifications).toHaveLength(20);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

posixTest("fails closed on a non-owner-only canonical lock directory", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "control.sock");
        const lockPath = `${path}.lock`;
        await mkdir(lockPath, { mode: 0o700 });
        await chmod(lockPath, 0o755);

        await expect(
            runHook({
                control: controlFor(path, unavailable),
                environment: hookEnvironmentFor(directory),
            }),
        ).rejects.toMatchObject({ _tag: "HookStartupError", operation: "lock" });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

posixTest("rejects invalid and incomplete lock owner schemas", async () => {
    const directory = await temporaryDirectory();
    try {
        const invalidLocks = [
            { pid: "not-an-integer", token: "invalid-owner", createdAt: Date.now() },
            { pid: 1, token: "incomplete-owner" },
        ];

        for (const [index, contents] of invalidLocks.entries()) {
            const path = join(directory, `control-${index}.sock`);
            const lockPath = `${path}.lock`;
            const token = contents.token;
            await mkdir(lockPath, { mode: 0o700 });
            await chmod(lockPath, 0o700);
            await writeFile(join(lockPath, `${token}.json`), JSON.stringify(contents), {
                mode: 0o600,
            });
            await chmod(join(lockPath, `${token}.json`), 0o600);

            let starts = 0;
            await expect(
                runHook({
                    control: controlFor(path, unavailable),
                    environment: hookEnvironmentFor(directory),
                    spawnDaemon: spawnFor(() => {
                        starts += 1;
                    }),
                }),
            ).rejects.toMatchObject({ _tag: "HookStartupError", operation: "lock" });
            expect(starts).toBe(0);
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test.skipIf(!isWindowsControlPlatform())(
    "rejects an unparseable Windows lock owner file instead of taking it over",
    async () => {
        const directory = await temporaryDirectory();
        const environment = hookEnvironmentFor(directory);
        try {
            const path = join(directory, "control.sock");
            const lockPath = controlLockPath(path, environment);
            await mkdir(dirname(lockPath), { recursive: true });
            await writeFile(lockPath, JSON.stringify({ pid: "not-an-integer", token: "bad" }));

            let starts = 0;
            await expect(
                runHook({
                    control: controlFor(path, unavailable),
                    environment,
                    spawnDaemon: spawnFor(() => {
                        starts += 1;
                    }),
                }),
            ).rejects.toMatchObject({ _tag: "HookStartupError", operation: "lock" });
            expect(starts).toBe(0);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);

posixTest("takes over a stale lock and never releases a resumed holder token", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "control.sock");
        const lockPath = `${path}.lock`;
        await mkdir(lockPath, { mode: 0o700 });
        await chmod(lockPath, 0o700);
        await writeFile(
            join(lockPath, "stale-token.json"),
            JSON.stringify({ pid: 1, token: "stale-token", createdAt: Date.now() - 5_001 }),
            { mode: 0o600 },
        );
        await chmod(join(lockPath, "stale-token.json"), 0o600);
        let ready = false;
        const control = controlFor(
            path,
            async () => {
                if (!ready) {
                    await unavailable();
                }
            },
            undefined,
            undefined,
            async (target) => {
                if (!ready) {
                    throw new ControlUnavailable(target, "connect");
                }
                return daemonHealth();
            },
        );

        await runHook({
            control,
            environment: hookEnvironmentFor(directory),
            token: () => "owner-token",
            spawnDaemon: () => {
                void (async () => {
                    await rm(join(lockPath, "owner-token.json"));
                    await writeFile(
                        join(lockPath, "resumed-token.json"),
                        JSON.stringify({ pid: 2, token: "resumed-token", createdAt: Date.now() }),
                    );
                    await chmod(join(lockPath, "resumed-token.json"), 0o600);
                    ready = true;
                })();
                return daemonFor();
            },
        });

        expect(
            JSON.parse(await readFile(join(lockPath, "resumed-token.json"), "utf8")),
        ).toMatchObject({
            token: "resumed-token",
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

posixTest(
    "takes over a stale empty lock directory without treating a fresh pending directory as stale",
    async () => {
        const directory = await temporaryDirectory();
        try {
            const path = join(directory, "control.sock");
            const lockPath = `${path}.lock`;
            await mkdir(lockPath, { mode: 0o700 });
            const stale = new Date(Date.now() - 5_001);
            await utimes(lockPath, stale, stale);
            let ready = false;
            let starts = 0;

            await runHook({
                control: controlFor(
                    path,
                    async () => {
                        if (!ready) {
                            await unavailable();
                        }
                    },
                    undefined,
                    undefined,
                    async (target) => {
                        if (!ready) {
                            throw new ControlUnavailable(target, "connect");
                        }
                        return daemonHealth();
                    },
                ),
                environment: hookEnvironmentFor(directory),
                spawnDaemon: spawnFor(() => {
                    starts += 1;
                    ready = true;
                }),
            });

            expect(starts).toBe(1);
            await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);

test("polls readiness through the 1.5-second deadline and releases its lock", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "control.sock");
        const environment = hookEnvironmentFor(directory);
        let now = 0;
        let probes = 0;
        let sleeps = 0;
        let starts = 0;
        const control = controlFor(path, unavailable, undefined, undefined, async (target) => {
            probes += 1;
            throw new ControlUnavailable(target, "connect");
        });

        await expect(
            runHook({
                control,
                environment,
                now: () => now,
                sleep: async (milliseconds) => {
                    sleeps += 1;
                    now += milliseconds;
                },
                spawnDaemon: spawnFor(() => {
                    starts += 1;
                }),
            }),
        ).rejects.toMatchObject({ _tag: "HookStartupError", operation: "readiness" });
        expect(now).toBe(1_500);
        expect(sleeps).toBe(60);
        expect(probes).toBe(62);
        expect(starts).toBe(1);
        await expect(readFile(controlLockPath(path, environment), "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("cancels only the daemon it spawned when readiness times out", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "control.sock");
        const environment = hookEnvironmentFor(directory);
        let now = 0;
        let starts = 0;
        let kills = 0;
        let notifications = 0;

        await expect(
            runHook({
                control: controlFor(path, async () => {
                    notifications += 1;
                }),
                environment,
                now: () => now,
                sleep: async (milliseconds) => {
                    now += milliseconds;
                },
                spawnDaemon: () => {
                    starts += 1;
                    return daemonFor({
                        kill: () => {
                            kills += 1;
                        },
                    });
                },
            }),
        ).rejects.toMatchObject({ _tag: "HookStartupError", operation: "readiness" });
        expect(starts).toBe(1);
        expect(kills).toBe(1);
        expect(notifications).toBe(0);
        await expect(readFile(controlLockPath(path, environment), "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("reports a daemon that exits before readiness without publishing a hint", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "control.sock");
        let notifications = 0;

        await expect(
            runHook({
                control: controlFor(path, async () => {
                    notifications += 1;
                }),
                environment: hookEnvironmentFor(directory),
                spawnDaemon: () => daemonFor({ exit: Promise.resolve(3) }),
            }),
        ).rejects.toMatchObject({
            _tag: "HookStartupError",
            operation: "readiness",
            message: expect.stringContaining("exited with code 3"),
        });
        expect(notifications).toBe(0);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("fails before spawning when the daemon log destination is unavailable", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "control.sock");
        const environment = hookEnvironmentFor(directory);
        const blocker = join(directory, "blocked");
        await writeFile(blocker, "not a directory");
        let starts = 0;

        await expect(
            runHook({
                control: controlFor(path, unavailable),
                environment,
                log: {
                    path: () => join(blocker, "logs", "daemon.log"),
                    preflight: preflightDaemonLog,
                },
                spawnDaemon: spawnFor(() => {
                    starts += 1;
                }),
            }),
        ).rejects.toMatchObject({ _tag: "HookStartupError", operation: "log" });
        expect(starts).toBe(0);
        await expect(readFile(controlLockPath(path, environment), "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("surfaces daemon spawn failures without leaving its lock behind", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "control.sock");
        const environment = hookEnvironmentFor(directory);
        const failure = new HookStartupError("spawn", "daemon spawn failed");

        await expect(
            runHook({
                control: controlFor(path, unavailable),
                environment,
                spawnDaemon: () => {
                    throw failure;
                },
            }),
        ).rejects.toBe(failure);
        await expect(readFile(controlLockPath(path, environment), "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("starts one daemon for start and reports the same instance afterwards", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "control.sock");
        // No hook payload at all: an explicit start never needs one.
        const environment: NodeJS.ProcessEnv = {
            LOCALAPPDATA: directory,
            USERPROFILE: directory,
        };
        let ready = false;
        let starts = 0;
        const control = controlFor(path, unavailable, undefined, undefined, async (target) => {
            if (!ready) {
                throw new ControlUnavailable(target, "connect");
            }
            return daemonHealth();
        });

        const started = await ensureDaemon({
            control,
            environment,
            spawnDaemon: () => {
                starts += 1;
                ready = true;
                return daemonFor();
            },
        });
        const reused = await ensureDaemon({
            control,
            environment,
            spawnDaemon: () => {
                starts += 1;
                return daemonFor();
            },
        });

        expect(started.status).toBe("started");
        expect(reused.status).toBe("already_running");
        expect(reused.daemon).toEqual(daemonHealth());
        expect(starts).toBe(1);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
