import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import { HookNotification } from "../../src/plugin/protocol.ts";

import { ControlUnavailable, controlLockPath } from "../../src/plugin/control.ts";
import { HookStartupError, runHook, type HookControlApi } from "../../src/plugin/hook.ts";
import {
    createWindowsLockCandidate,
    isWindowsLockContentionError,
    publishWindowsLockFile,
    readWindowsLockFile,
    takeWindowsLockFile,
    WindowsLockContended,
} from "../../src/plugin/windows-lock.ts";
import { windowsControlPipePath } from "../../src/plugin/windows-pipe.ts";

const windowsTest = test.skipIf(process.platform !== "win32");

const hasPowerShell =
    Bun.spawnSync(["pwsh", "-NoProfile", "-NonInteractive", "-Command", "exit 0"]).exitCode === 0;
const windowsPowerShellTest = test.skipIf(process.platform !== "win32" || !hasPowerShell);

const uniquePipe = (): string =>
    windowsControlPipePath(randomUUID().replaceAll("-", "").slice(0, 16));

const temporaryDirectory = (): Promise<string> => mkdtemp(join(tmpdir(), "zed-herdr-lock-"));

const hookEnvironment = (localAppData: string): NodeJS.ProcessEnv => ({
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
        data: { workspace: { workspace_id: "event-workspace" } },
    }),
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: "C:\\repos\\event" }),
    HERDR_WORKSPACE_ID: "environment-workspace",
    LOCALAPPDATA: localAppData,
});

const controlFor = (path: string, notify: HookControlApi["notifyControl"]): HookControlApi => ({
    controlSocketPath: () => path,
    healthControl: async () => {
        await notify(
            path,
            Schema.decodeUnknownSync(HookNotification)({
                workspaceId: "event-workspace",
                cwd: "C:\\repos\\event",
            }),
        );
        return {
            identity: "artisann.zed-herdr:daemon",
            paneId: null,
            pid: 42,
            startedAt: "2026-01-01T00:00:00.000Z",
            protocol: null,
            beyondTested: false,
        };
    },
    notifyControl: notify,
    prepareControlSocket: async () => undefined,
    prepareControlSocketDirectory: async () => undefined,
});

const fakeDaemon = () => ({
    pid: 42,
    exited: new Promise<number>(() => undefined),
    kill: () => undefined,
});

const lockContents = (token: string, createdAt: number): string =>
    JSON.stringify({ pid: process.pid, token, createdAt });

windowsTest("publishes the lock exactly once through a hard link", async () => {
    const directory = await temporaryDirectory();
    try {
        const canonical = join(directory, "hook.lock");
        const candidate = join(directory, "hook.lock.candidate");
        await createWindowsLockCandidate(candidate, lockContents("token-a", 1));

        const candidateSnapshot = await readWindowsLockFile(candidate);
        expect(candidateSnapshot?.contents).toBe(lockContents("token-a", 1));

        await publishWindowsLockFile(candidate, canonical);
        const published = await readWindowsLockFile(canonical);
        expect(published?.identity).toEqual(candidateSnapshot?.identity);

        await createWindowsLockCandidate(candidate, lockContents("token-b", 2));
        await expect(publishWindowsLockFile(candidate, canonical)).rejects.toMatchObject({
            code: "EEXIST",
        });

        const current = await readWindowsLockFile(canonical);
        expect(current?.contents).toBe(lockContents("token-a", 1));
        expect(current?.identity).toEqual(published?.identity);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

windowsTest("takes a lock file only while its identity still matches", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "hook.lock");
        await writeFile(path, lockContents("token-a", 1));
        const snapshot = await readWindowsLockFile(path);
        expect(snapshot).not.toBeNull();
        if (snapshot === null) {
            return;
        }

        expect(await takeWindowsLockFile(path, { dev: snapshot.identity.dev, ino: 0 })).toBe(
            "changed",
        );
        expect((await readWindowsLockFile(path))?.contents).toBe(lockContents("token-a", 1));

        expect(await takeWindowsLockFile(path, snapshot.identity)).toBe("taken");
        expect(await readWindowsLockFile(path)).toBeNull();
        expect(await takeWindowsLockFile(path, snapshot.identity)).toBe("absent");

        await mkdir(join(directory, "directory.lock"));
        await expect(readWindowsLockFile(join(directory, "directory.lock"))).rejects.toMatchObject({
            reason: "not_file",
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

windowsTest("opens exactly one daemon pane for concurrent hooks", async () => {
    const directory = await temporaryDirectory();
    const path = uniquePipe();
    try {
        const panes: Array<ReadonlyArray<string>> = [];
        let daemonReady = false;
        const notify = async (): Promise<void> => {
            if (!daemonReady) {
                throw new ControlUnavailable(path, "connect");
            }
        };
        const spawnDaemon = () => {
            panes.push([]);
            daemonReady = true;
            return fakeDaemon();
        };

        const results = await Promise.all(
            [0, 1].map(
                async () =>
                    await runHook({
                        control: controlFor(path, notify),
                        environment: hookEnvironment(directory),
                        spawnDaemon,
                    }),
            ),
        );

        expect(panes).toHaveLength(1);
        expect(results.every((result) => result._tag === "Notified")).toBe(true);
        expect(await readLockFileOrNull(directory, path)).toBeNull();
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

const readLockFileOrNull = async (directory: string, path: string): Promise<string | null> => {
    try {
        return await readFile(controlLockPath(path, { LOCALAPPDATA: directory }), "utf8");
    } catch (error) {
        if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
        ) {
            return null;
        }
        throw error;
    }
};

windowsTest("takes over an abandoned lock from a previous hook", async () => {
    const directory = await temporaryDirectory();
    const path = uniquePipe();
    try {
        const lockPath = controlLockPath(path, { LOCALAPPDATA: directory });
        await mkdir(join(directory, "zed-herdr", "locks"), { recursive: true });
        await writeFile(lockPath, lockContents(randomUUID(), Date.now() - 10_000));

        let panes = 0;
        let daemonReady = false;
        const result = await runHook({
            control: controlFor(path, async () => {
                if (!daemonReady) {
                    throw new ControlUnavailable(path, "connect");
                }
            }),
            environment: hookEnvironment(directory),
            spawnDaemon: () => {
                panes += 1;
                daemonReady = true;
                return fakeDaemon();
            },
        });

        expect(result).toEqual({ _tag: "Notified", startedDaemon: true });
        expect(panes).toBe(1);
        expect(await readLockFileOrNull(directory, path)).toBeNull();
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

windowsTest("never deletes a live lock owned by another hook", async () => {
    const directory = await temporaryDirectory();
    const path = uniquePipe();
    try {
        const lockPath = controlLockPath(path, { LOCALAPPDATA: directory });
        await mkdir(join(directory, "zed-herdr", "locks"), { recursive: true });
        const token = randomUUID();
        const contents = lockContents(token, 0);
        await writeFile(lockPath, contents);

        let clock = 0;
        const sleep = async (milliseconds: number): Promise<void> => {
            clock += milliseconds;
        };
        let panes = 0;
        const failure = await runHook({
            control: controlFor(path, async () => {
                throw new ControlUnavailable(path, "connect");
            }),
            environment: hookEnvironment(directory),
            spawnDaemon: () => {
                panes += 1;
                return fakeDaemon();
            },
            now: () => clock,
            sleep,
        }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(HookStartupError);
        expect((failure as HookStartupError).operation).toBe("readiness");
        expect(clock).toBe(1_500);
        expect(panes).toBe(0);
        expect(await readFile(lockPath, "utf8")).toBe(contents);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

windowsTest("classifies transient sharing denials without calling them unsafe", () => {
    for (const code of ["EBUSY", "EACCES", "EPERM"]) {
        expect(isWindowsLockContentionError(Object.assign(new Error(code), { code }))).toBe(true);
    }
    for (const code of ["ENOENT", "EEXIST", "EIO"]) {
        expect(isWindowsLockContentionError(Object.assign(new Error(code), { code }))).toBe(false);
    }
    expect(isWindowsLockContentionError(new Error("no code"))).toBe(false);
});

windowsPowerShellTest(
    "polls a lock held by a foreign exclusive handle instead of deleting it",
    async () => {
        const directory = await temporaryDirectory();
        const lockPath = join(directory, "hook.lock");
        const contents = lockContents(randomUUID(), 0);
        await writeFile(lockPath, contents);
        const inspected = await readWindowsLockFile(lockPath);
        if (inspected === null) {
            throw new Error("expected the lock file to be readable before contention");
        }

        const holder = Bun.spawn({
            cmd: [
                "pwsh",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                `$handle=[System.IO.File]::Open('${lockPath}','Open','Read','None'); Write-Output 'ready'; Start-Sleep -Seconds 20; $handle.Dispose()`,
            ],
            stdout: "pipe",
        });
        const reader = holder.stdout.getReader();
        try {
            const { value } = await reader.read();
            expect(new TextDecoder().decode(value ?? new Uint8Array()).trim()).toBe("ready");

            // Windows reports the sharing violation as EBUSY (measured). It must
            // never be read as "malformed lock", "absent lock" or a takeover.
            await expect(readWindowsLockFile(lockPath)).rejects.toBeInstanceOf(
                WindowsLockContended,
            );
            expect(await takeWindowsLockFile(lockPath, inspected.identity)).toBe("changed");
            expect((await lstat(lockPath)).isFile()).toBe(true);
        } finally {
            holder.kill("SIGKILL");
            await holder.exited;
        }
        // The held lock survived the denied capture untouched.
        expect(await readFile(lockPath, "utf8")).toBe(contents);
        await rm(directory, { recursive: true, force: true });
    },
);

windowsPowerShellTest("waits out a contended lock instead of failing the hook", async () => {
    const directory = await temporaryDirectory();
    const path = uniquePipe();
    const environment = hookEnvironment(directory);
    const lockPath = controlLockPath(path, environment);
    await mkdir(join(directory, "zed-herdr", "locks"), { recursive: true });
    const contents = lockContents(randomUUID(), 0);
    await writeFile(lockPath, contents);

    const holder = Bun.spawn({
        cmd: [
            "pwsh",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `$handle=[System.IO.File]::Open('${lockPath}','Open','Read','None'); Write-Output 'ready'; Start-Sleep -Seconds 20; $handle.Dispose()`,
        ],
        stdout: "pipe",
    });
    const reader = holder.stdout.getReader();
    try {
        const { value } = await reader.read();
        expect(new TextDecoder().decode(value ?? new Uint8Array()).trim()).toBe("ready");

        let clock = 0;
        let panes = 0;
        const failure = await runHook({
            control: controlFor(path, async () => {
                throw new ControlUnavailable(path, "connect");
            }),
            environment,
            spawnDaemon: () => {
                panes += 1;
                return fakeDaemon();
            },
            now: () => clock,
            sleep: async (milliseconds: number) => {
                clock += milliseconds;
            },
        }).catch((error: unknown) => error);

        // Contention is a poll-and-wait condition, never a fatal "lock" error
        // or a takeover of a lock that is merely unreadable.
        expect(failure).toBeInstanceOf(HookStartupError);
        expect((failure as HookStartupError).operation).toBe("readiness");
        expect(clock).toBe(1_500);
        expect(panes).toBe(0);
    } finally {
        holder.kill("SIGKILL");
        await holder.exited;
    }
    expect(await readFile(lockPath, "utf8")).toBe(contents);
    await rm(directory, { recursive: true, force: true });
});
