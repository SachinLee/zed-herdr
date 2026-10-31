import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
    lstat,
    link,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as Effect from "effect/Effect";

import {
    DAEMON_LOG_MAX_BYTES,
    DAEMON_LOG_RECORD_MAX_BYTES,
    DaemonLogError,
    daemonLogLoggerLayer,
    daemonLogPath,
    openDaemonLog,
    preflightDaemonLog,
} from "../../src/plugin/daemon-log.ts";
import { isWindowsControlPlatform, windowsControlPipePath } from "../../src/plugin/windows-pipe.ts";

const posixTest = test.skipIf(isWindowsControlPlatform());
const windowsTest = test.skipIf(!isWindowsControlPlatform());

const temporaryDirectory = (): Promise<string> => mkdtemp(join(tmpdir(), "zed-herdr-log-"));

const temporaryEnvironment = (directory: string): NodeJS.ProcessEnv => ({
    LOCALAPPDATA: directory,
    USERPROFILE: directory,
});

const controlPathFor = (directory: string, seed: string): string =>
    isWindowsControlPlatform()
        ? windowsControlPipePath(seed)
        : join(directory, "zed-herdr", `${seed}.sock`);

const readLines = async (path: string): Promise<ReadonlyArray<string>> =>
    (await readFile(path, "utf8")).split("\n").filter((line) => line.length > 0);

test("derives one fixed log name per control endpoint", () => {
    const controlPath = controlPathFor("endpoint-seed-0001", "a1b2c3d4e5f60718");
    const environment = temporaryEnvironment(tmpdir());

    const path = daemonLogPath(controlPath, environment);

    expect(daemonLogPath(controlPath, environment)).toBe(path);
    expect(basename(path)).toMatch(/^[0-9a-f]{16}\.log$/);
    expect(basename(path)).not.toContain(String(process.pid));
    expect(
        daemonLogPath(controlPathFor("endpoint-seed-0002", "a1b2c3d4e5f60719"), environment),
    ).not.toBe(path);
});

windowsTest("fails when the Windows state root is unavailable", () => {
    expect(() => daemonLogPath(windowsControlPipePath("0123456789abcdef"), {})).toThrow(
        DaemonLogError,
    );
});

test("appends one JSON record per line to a single private file", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "daemon.log");
        const log = await openDaemonLog(path);

        await log.writeRecord({ type: "one", value: 1 });
        await log.writeJsonLine(JSON.stringify({ type: "two" }));
        await log.close();

        const lines = await readLines(path);
        expect(lines.map((line) => JSON.parse(line))).toEqual([
            { type: "one", value: 1 },
            { type: "two" },
        ]);
        expect(await readdir(directory)).toEqual(["daemon.log"]);
        if (!isWindowsControlPlatform()) {
            expect((await lstat(path)).mode & 0o777).toBe(0o600);
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("finishes each bounded write before returning so producers cannot build a backlog", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "daemon.log");
        const log = await openDaemonLog(path);
        try {
            log.writeRecord({ type: "immediate" });
            expect(readFileSync(path, "utf8")).toBe('{"type":"immediate"}\n');
        } finally {
            await log.close();
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("truncates in place instead of keeping backups when the log fills up", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "daemon.log");
        const log = await openDaemonLog(path);
        const payload = "x".repeat(8 * 1024);

        for (let index = 0; index < 200; index += 1) {
            await log.writeRecord({ type: "fill", index, payload });
        }
        await log.close();

        expect((await lstat(path)).size).toBeLessThanOrEqual(DAEMON_LOG_MAX_BYTES);
        expect(await readdir(directory)).toEqual(["daemon.log"]);
        const lines = await readLines(path);
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
            expect(() => JSON.parse(line)).not.toThrow();
        }
        expect(JSON.parse(lines.at(-1) ?? "null").type).toBe("fill");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("replaces an oversized record with a bounded JSON record", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "daemon.log");
        const log = await openDaemonLog(path);

        await log.writeRecord({ type: "huge", payload: "y".repeat(64 * 1024) });
        await log.close();

        const lines = await readLines(path);
        expect(lines.length).toBe(1);
        const line = lines[0] ?? "";
        expect(Buffer.byteLength(line)).toBeLessThanOrEqual(DAEMON_LOG_RECORD_MAX_BYTES);
        expect(JSON.parse(line).type).toBe("log_truncated");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("preflight writes a record the daemon can append to", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "daemon.log");

        await preflightDaemonLog(path);
        const log = await openDaemonLog(path);
        await log.writeRecord({ type: "daemon_started" });
        await log.close();

        const lines = await readLines(path);
        expect(lines.map((line) => JSON.parse(line).type)).toEqual([
            "daemon_log_preflight",
            "daemon_started",
        ]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("fails with a bounded error when the destination cannot be created", async () => {
    const directory = await temporaryDirectory();
    try {
        const blocker = join(directory, "blocked");
        await writeFile(blocker, "not a directory");
        const path = join(blocker, "logs", "daemon.log");

        const opened = await openDaemonLog(path).then(
            () => undefined,
            (error: unknown) => error,
        );
        expect(opened).toBeInstanceOf(DaemonLogError);
        expect(opened instanceof Error ? opened.message.length : 0).toBeLessThanOrEqual(4_096);

        const preflight = await preflightDaemonLog(path).then(
            () => undefined,
            (error: unknown) => error,
        );
        expect(preflight).toBeInstanceOf(DaemonLogError);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("refuses a directory in place of the log file", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "daemon.log");
        await mkdir(path);

        await expect(openDaemonLog(path)).rejects.toBeInstanceOf(DaemonLogError);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

posixTest("refuses a symlinked log file", async () => {
    const directory = await temporaryDirectory();
    try {
        const target = join(directory, "target.log");
        await writeFile(target, "");
        const path = join(directory, "daemon.log");
        await symlink(target, path);

        await expect(openDaemonLog(path)).rejects.toBeInstanceOf(DaemonLogError);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

posixTest("refuses a log file with additional hard links", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "daemon.log");
        const log = await openDaemonLog(path);
        await log.close();
        await link(path, join(directory, "alias.log"));

        await expect(openDaemonLog(path)).rejects.toBeInstanceOf(DaemonLogError);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("notifies the first write failure once and keeps rejecting", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "daemon.log");
        const failures: Array<string> = [];
        const log = await openDaemonLog(path, (error) => {
            failures.push(error.message);
        });

        await log.writeRecord({ type: "one" });
        await log.close();

        expect(() => log.writeRecord({ type: "two" })).toThrow(DaemonLogError);
        expect(() => log.writeRecord({ type: "three" })).toThrow(DaemonLogError);

        expect(failures.length).toBe(1);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("routes Effect log output into the log file instead of the console", async () => {
    const directory = await temporaryDirectory();
    const messages: Array<string> = [];
    const originalLog = console.log;
    const originalError = console.error;
    try {
        const path = join(directory, "daemon.log");
        const log = await openDaemonLog(path);
        console.log = (...arguments_: ReadonlyArray<unknown>) => {
            messages.push(arguments_.map(String).join(" "));
        };
        console.error = (...arguments_: ReadonlyArray<unknown>) => {
            messages.push(arguments_.map(String).join(" "));
        };
        try {
            await Effect.runPromise(
                Effect.log("daemon hello").pipe(Effect.provide(daemonLogLoggerLayer(log))),
            );
        } finally {
            console.log = originalLog;
            console.error = originalError;
            await log.close();
        }

        const lines = await readLines(path);
        expect(lines.length).toBe(1);
        expect(JSON.parse(lines[0] ?? "null").message).toBe("daemon hello");
        expect(messages).toEqual([]);
    } finally {
        console.log = originalLog;
        console.error = originalError;
        await rm(directory, { recursive: true, force: true });
    }
});
