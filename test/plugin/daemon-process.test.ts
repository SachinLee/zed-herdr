import { expect, test } from "bun:test";
import { isAbsolute, join } from "node:path";

import {
    BACKGROUND_DAEMON_MARKER,
    daemonEntryPoint,
    daemonLaunch,
    type BackgroundDaemonLaunch,
    spawnDetached,
} from "../../src/plugin/daemon-process.ts";

const entry = join(process.cwd(), "index.ts");

const launchFor = (script: string): BackgroundDaemonLaunch => ({
    cmd: [process.execPath, "-e", script],
    env: { ...process.env } as Record<string, string>,
    detached: true,
    windowsHide: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
});

test("builds an absolute detached launch that never shells out or opens a pane", () => {
    const launch = daemonLaunch({ PATH: "/usr/bin", HERDR_SESSION: "work" }, entry);

    expect(launch.cmd).toEqual([process.execPath, entry, "daemon"]);
    expect(isAbsolute(launch.cmd[1] ?? "")).toBe(true);
    expect(launch.cmd.join(" ")).not.toContain("pane");
    expect(launch.cmd.join(" ")).not.toContain("plugin open");
    expect(launch.detached).toBe(true);
    expect(launch.windowsHide).toBe(true);
    expect(launch.stdin).toBe("ignore");
    expect(launch.stdout).toBe("ignore");
    expect(launch.stderr).toBe("ignore");
});

test("inherits the caller environment without the hook pane identity", () => {
    const launch = daemonLaunch(
        {
            HERDR_PANE_ID: "pane-1",
            HERDR_SESSION: "work",
            XDG_CONFIG_HOME: "/config",
            ZED_BIN: "/opt/zed",
            ZED_HERDR_PROJECT_MODE: "worktree",
        },
        entry,
    );

    expect(launch.env.HERDR_PANE_ID).toBeUndefined();
    expect(launch.env.HERDR_SESSION).toBe("work");
    expect(launch.env.XDG_CONFIG_HOME).toBe("/config");
    expect(launch.env.ZED_BIN).toBe("/opt/zed");
    expect(launch.env.ZED_HERDR_PROJECT_MODE).toBe("worktree");
    expect(launch.env[BACKGROUND_DAEMON_MARKER]).toBe("1");
});

test("copies the environment instead of mutating the caller's object", () => {
    const environment: NodeJS.ProcessEnv = { HERDR_PANE_ID: "pane-1" };
    const launch = daemonLaunch(environment, entry);

    expect(environment.HERDR_PANE_ID).toBe("pane-1");
    expect(environment[BACKGROUND_DAEMON_MARKER]).toBeUndefined();
    launch.env.PATH = "/tmp";
    expect(environment.PATH).toBeUndefined();
});

test("drops empty environment entries instead of forwarding undefined values", () => {
    const launch = daemonLaunch({ HERDR_SESSION: undefined, PATH: "/usr/bin" }, entry);

    expect(Object.hasOwn(launch.env, "HERDR_SESSION")).toBe(false);
    expect(launch.env.PATH).toBe("/usr/bin");
});

test("resolves the running entry point to an absolute script path", () => {
    const resolved = daemonEntryPoint();

    expect(isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith(".ts") || resolved.endsWith(".js")).toBe(true);
});

test("spawns a detached child that reports its own exit code", async () => {
    const daemon = spawnDetached(launchFor("process.exit(7)"));

    expect(daemon.pid).toBeGreaterThan(0);
    expect(await daemon.exited).toBe(7);
});

test("cancels only the handle that this invocation spawned", async () => {
    const daemon = spawnDetached(launchFor("setTimeout(() => undefined, 30_000)"));
    const exit = daemon.exited;

    expect(daemon.pid).toBeGreaterThan(0);
    daemon.kill();
    expect(await exit).not.toBe(0);
});

test("tolerates killing a child that already exited", async () => {
    const daemon = spawnDetached(launchFor("process.exit(0)"));

    expect(await daemon.exited).toBe(0);
    expect(() => daemon.kill()).not.toThrow();
});
