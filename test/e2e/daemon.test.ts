import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
    appendFile,
    chmod,
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { controlSocketPath } from "../../src/plugin/control.ts";
import { daemonLogPath } from "../../src/plugin/daemon-log.ts";
const isWindows = process.platform === "win32";

/**
 * HerdR addresses a Unix-domain socket by path on POSIX and a named pipe on Windows.
 * The pipe name is the socket path verbatim behind `\\.\pipe\`; HerdR itself prefixes
 * it, so the fake server must listen on the prefixed name while the daemon still
 * receives the plain path through `HERDR_SOCKET_PATH`.
 */
const socketTarget = (path: string): string => (isWindows ? `\\\\.\\pipe\\${path}` : path);

interface HerdRRequest {
    readonly id: string;
    readonly method: string;
    readonly params: unknown;
}

interface HerdRConnection {
    buffer: string;
    readonly decoder: TextDecoder;
}

interface RecorderConnection {
    buffer: string;
    readonly decoder: TextDecoder;
}

interface ReceivedRequest {
    readonly request: HerdRRequest;
    readonly socket: Bun.Socket<HerdRConnection>;
}

const defaultArtifactPath = resolve(import.meta.dir, "../../dist/index.js");

const resolveArtifactPath = (environment: NodeJS.ProcessEnv): string => {
    const override = environment.ZED_HERDR_TEST_DIST;
    const artifactPath = override ?? defaultArtifactPath;

    if (override !== undefined && !isAbsolute(override)) {
        throw new Error("ZED_HERDR_TEST_DIST must be an absolute path");
    }
    if (!existsSync(artifactPath)) {
        throw new Error(`Built daemon artifact does not exist: ${artifactPath}`);
    }
    return artifactPath;
};

const snapshot = (repoA: string, repoB: string, focusedWorkspaceId: string) => ({
    version: "0.9.3",
    protocol: 22,
    workspaces: [
        {
            workspace_id: "workspace-a",
            number: 1,
            label: "repo-a",
            focused: focusedWorkspaceId === "workspace-a",
            pane_count: 0,
            tab_count: 0,
            active_tab_id: "tab-a",
            agent_status: "idle",
            worktree: {
                repo_key: "repo-a",
                repo_name: "repo-a",
                repo_root: repoA,
                checkout_path: repoA,
                is_linked_worktree: false,
            },
        },
        {
            workspace_id: "workspace-b",
            number: 2,
            label: "repo-b",
            focused: focusedWorkspaceId === "workspace-b",
            pane_count: 0,
            tab_count: 0,
            active_tab_id: "tab-b",
            agent_status: "idle",
            worktree: {
                repo_key: "repo-b",
                repo_name: "repo-b",
                repo_root: repoB,
                checkout_path: repoB,
                is_linked_worktree: false,
            },
        },
    ],
    tabs: [],
    panes: [],
    layouts: [],
    agents: [],
    focused_workspace_id: focusedWorkspaceId,
    focused_tab_id: null,
    focused_pane_id: null,
});

const snapshotResponse = (request: HerdRRequest, value: unknown) => ({
    id: request.id,
    result: { type: "session_snapshot", snapshot: value },
});

const singleWorkspaceSnapshot = (checkoutPath: string) => ({
    version: "0.9.3",
    protocol: 22,
    workspaces: [
        {
            workspace_id: "workspace-a",
            number: 1,
            label: "repo-a",
            focused: true,
            pane_count: 0,
            tab_count: 0,
            active_tab_id: "tab-a",
            agent_status: "idle",
            worktree: {
                repo_key: "repo-a",
                repo_name: "repo-a",
                repo_root: checkoutPath,
                checkout_path: checkoutPath,
                is_linked_worktree: false,
            },
        },
    ],
    tabs: [],
    panes: [],
    layouts: [],
    agents: [],
    focused_workspace_id: "workspace-a",
    focused_tab_id: null,
    focused_pane_id: null,
});

const subscriptionStarted = (request: HerdRRequest) => ({
    id: request.id,
    result: { type: "subscription_started" },
});

const focusedEvent = (workspaceId: string) => ({
    event: "workspace_focused",
    data: { type: "workspace_focused", workspace_id: workspaceId },
});

const parseRequest = (frame: string): HerdRRequest => {
    const value: unknown = JSON.parse(frame);
    if (
        value === null ||
        typeof value !== "object" ||
        !("id" in value) ||
        typeof value.id !== "string" ||
        !("method" in value) ||
        typeof value.method !== "string" ||
        !("params" in value)
    ) {
        throw new Error(`Unexpected HerdR request: ${frame}`);
    }
    return value as HerdRRequest;
};

class HerdRServer {
    readonly #listener: Bun.UnixSocketListener<HerdRConnection>;
    readonly #requests: Array<ReceivedRequest> = [];
    readonly #waiters: Array<{
        readonly method: string;
        readonly resolve: (request: ReceivedRequest) => void;
    }> = [];
    #closedConnections = 0;
    readonly #closedSockets = new Set<Bun.Socket<HerdRConnection>>();
    readonly #closeWaiters: Array<{
        readonly socket: Bun.Socket<HerdRConnection> | undefined;
        readonly resolve: () => void;
    }> = [];

    constructor(path: string) {
        this.#listener = Bun.listen<HerdRConnection>({
            unix: socketTarget(path),
            socket: {
                open(socket) {
                    socket.data = { buffer: "", decoder: new TextDecoder() };
                },
                data: (socket, data) => {
                    const connection = socket.data;
                    connection.buffer += connection.decoder.decode(data, { stream: true });
                    for (;;) {
                        const newline = connection.buffer.indexOf("\n");
                        if (newline < 0) {
                            return;
                        }
                        const frame = connection.buffer.slice(0, newline);
                        connection.buffer = connection.buffer.slice(newline + 1);
                        if (frame.length > 0) {
                            this.#offer({ request: parseRequest(frame), socket });
                        }
                    }
                },
                close: (socket) => {
                    this.#closedConnections += 1;
                    this.#closedSockets.add(socket);
                    for (let index = this.#closeWaiters.length - 1; index >= 0; index -= 1) {
                        const waiter = this.#closeWaiters[index]!;
                        if (waiter.socket === undefined || waiter.socket === socket) {
                            this.#closeWaiters.splice(index, 1);
                            waiter.resolve();
                        }
                    }
                },
            },
        });
    }

    close(): void {
        this.#listener.stop();
    }

    nextRequest(method: string): Promise<ReceivedRequest> {
        const index = this.#requests.findIndex((received) => received.request.method === method);
        if (index >= 0) {
            return Promise.resolve(this.#requests.splice(index, 1)[0]!);
        }

        const pending = Promise.withResolvers<ReceivedRequest>();
        this.#waiters.push({ method, resolve: pending.resolve });
        return pending.promise;
    }

    send(socket: Bun.Socket<HerdRConnection>, value: unknown): void {
        socket.write(`${JSON.stringify(value)}\n`);
    }

    /** Resolves once the daemon has closed its HerdR session socket. */
    waitForConnectionClose(socket?: Bun.Socket<HerdRConnection>): Promise<void> {
        if (socket === undefined ? this.#closedConnections > 0 : this.#closedSockets.has(socket)) {
            return Promise.resolve();
        }
        const pending = Promise.withResolvers<void>();
        this.#closeWaiters.push({ socket, resolve: pending.resolve });
        return pending.promise;
    }

    writeRaw(socket: Bun.Socket<HerdRConnection>, frame: string): void {
        socket.write(frame);
    }

    #offer(received: ReceivedRequest): void {
        const index = this.#waiters.findIndex(
            (waiter) => waiter.method === received.request.method,
        );
        if (index < 0) {
            this.#requests.push(received);
            return;
        }
        this.#waiters.splice(index, 1)[0]!.resolve(received);
    }
}

class RecorderServer {
    readonly #listener: Bun.UnixSocketListener<RecorderConnection>;
    readonly #waiters: Array<{
        readonly count: number;
        readonly resolve: () => void;
    }> = [];
    readonly records: Array<string> = [];

    constructor(path: string) {
        this.#listener = Bun.listen<RecorderConnection>({
            unix: socketTarget(path),
            socket: {
                open(socket) {
                    socket.data = { buffer: "", decoder: new TextDecoder() };
                },
                data: (socket, data) => {
                    const connection = socket.data;
                    connection.buffer += connection.decoder.decode(data, { stream: true });
                    for (;;) {
                        const newline = connection.buffer.indexOf("\n");
                        if (newline < 0) {
                            return;
                        }
                        const record = connection.buffer.slice(0, newline);
                        connection.buffer = connection.buffer.slice(newline + 1);
                        if (record.length > 0) {
                            this.records.push(record);
                            this.#settleWaiters();
                            socket.end("ok\n");
                        }
                    }
                },
            },
        });
    }

    close(): void {
        this.#listener.stop();
    }

    waitForCount(count: number): Promise<void> {
        if (this.records.length >= count) {
            return Promise.resolve();
        }

        const pending = Promise.withResolvers<void>();
        this.#waiters.push({ count, resolve: pending.resolve });
        return pending.promise;
    }

    #settleWaiters(): void {
        for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
            const waiter = this.#waiters[index];
            if (waiter !== undefined && this.records.length >= waiter.count) {
                this.#waiters.splice(index, 1)[0]!.resolve();
            }
        }
    }
}

const createGitRepository = async (path: string): Promise<string> => {
    const initialized = Bun.spawn(["git", "init", "--quiet", path], {
        stderr: "ignore",
        stdout: "ignore",
    });
    expect(await initialized.exited).toBe(0);
    return realpath(path);
};

const fakeZedBody = String.raw`const recorderSocket = process.env.ZED_HERDR_RECORDER_SOCKET;
if (recorderSocket === undefined) {
    throw new Error("ZED_HERDR_RECORDER_SOCKET is required");
}
const target = process.platform === "win32" ? "\\\\.\\pipe\\" + recorderSocket : recorderSocket;
const completed = Promise.withResolvers();
void Bun.connect({
    unix: target,
    socket: {
        open(socket) {
            socket.write(process.argv.slice(2).join(" ") + "\n");
        },
        data(socket) {
            socket.end();
            completed.resolve();
        },
        error(_socket, error) {
            completed.reject(error);
        },
    },
}).catch(completed.reject);
await completed.promise;
`;

const fakeZedSource = `#!/usr/bin/env bun\n${fakeZedBody}`;

/**
 * Compiles the fake Zed into a standalone Windows executable. The editor adapter spawns
 * through `node:child_process`, which rejects `.cmd` shims without a shell, and Windows
 * cannot execute a shebang script, so a native executable is the only faithful fake.
 */
const compileWindowsFakeZed = async (directory: string): Promise<string> => {
    const sourcePath = join(directory, "fake-zed.ts");
    const executablePath = join(directory, "fake-zed.exe");
    await writeFile(sourcePath, fakeZedBody);

    const build = Bun.spawn(
        [process.execPath, "build", "--compile", "--outfile", executablePath, sourcePath],
        { stderr: "pipe", stdout: "ignore" },
    );
    if ((await build.exited) !== 0) {
        const stderr = await new Response(build.stderr).text();
        throw new Error(`Failed to compile fake Zed: ${stderr.slice(-4096)}`);
    }
    return executablePath;
};

/**
 * Writes a fake `zed` that records its argv over the recorder socket and returns the
 * executable to pass as `ZED_BIN`.
 */
const writeFakeZed = async (directory: string): Promise<string> => {
    if (isWindows) {
        return compileWindowsFakeZed(directory);
    }

    const scriptPath = join(directory, "fake-zed");
    await writeFile(scriptPath, fakeZedSource);
    await chmod(scriptPath, 0o755);
    return scriptPath;
};

const daemonEnvironment = (directory: string, fakeZed: string): NodeJS.ProcessEnv => ({
    ...process.env,
    HERDR_SOCKET_PATH: join(directory, "herdr.sock"),
    ZED_BIN: fakeZed,
    ZED_HERDR_RECORDER_SOCKET: join(directory, "recorder.sock"),
    ...(isWindows ? { LOCALAPPDATA: join(directory, "local-app-data") } : {}),
});

const spawnDaemon = (artifactPath: string, environment: NodeJS.ProcessEnv): Bun.Subprocess =>
    Bun.spawn([process.execPath, artifactPath, "daemon"], {
        env: environment,
        stderr: "ignore",
        stdin: "ignore",
        stdout: "ignore",
    });

/** Stops the daemon and asserts the platform's shutdown observation. */
const stopDaemon = async (daemon: Bun.Subprocess): Promise<void> => {
    daemon.kill("SIGTERM");
    const exitCode = await daemon.exited;
    if (isWindows) {
        // Windows terminates the native process; Bun reports the conventional 128+15.
        expect(exitCode).toBe(143);
    } else {
        expect(exitCode).toBe(0);
    }
};

/** Runs one control command from the built artifact against an existing daemon. */
const runControlCommand = async (
    artifactPath: string,
    command: "health" | "stop" | "start" | "hook",
    environment: NodeJS.ProcessEnv,
): Promise<{ readonly exitCode: number; readonly stderr: string; readonly stdout: string }> => {
    const child = Bun.spawn([process.execPath, artifactPath, command], {
        env: environment,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    return { exitCode, stderr, stdout };
};
test("built start survives its parent, reuses the daemon, and stops through control", async () => {
    const artifactPath = resolveArtifactPath(process.env);
    const directory = await mkdtemp(join(tmpdir(), "zh-e2e-background-"));
    const environment = { ...daemonEnvironment(directory, "zed"), HERDR_PANE_ID: "unrelated" };
    try {
        const first = await runControlCommand(artifactPath, "start", environment);
        expect(first.exitCode).toBe(0);
        const health = await runControlCommand(artifactPath, "health", environment);
        expect(health.exitCode).toBe(0);
        const instance = JSON.parse(health.stdout).daemon;
        const logPath = daemonLogPath(controlSocketPath(environment), environment);
        const firstRecord = JSON.parse((await readFile(logPath, "utf8")).trim().split("\n")[1]!);
        expect(firstRecord).toEqual({ type: "daemon_started", pid: instance.pid });
        expect(instance.paneId).toBeNull();
        const second = await runControlCommand(artifactPath, "start", environment);
        expect(second.exitCode).toBe(0);
        const again = JSON.parse(
            (await runControlCommand(artifactPath, "health", environment)).stdout,
        ).daemon;
        expect(again.pid).toBe(instance.pid);
        expect(again.startedAt).toBe(instance.startedAt);
        expect((await runControlCommand(artifactPath, "stop", environment)).exitCode).toBe(0);
        expect((await runControlCommand(artifactPath, "health", environment)).exitCode).toBe(1);
    } finally {
        await runControlCommand(artifactPath, "stop", environment);
        await removeDirectory(directory);
    }
}, 15_000);

/** Waits for a graceful exit, failing loudly instead of hanging the suite. */
const exitWithin = async (daemon: Bun.Subprocess, timeoutMs: number): Promise<number> => {
    const outcome = await Promise.race([
        daemon.exited,
        Bun.sleep(timeoutMs).then(() => "timeout" as const),
    ]);
    if (outcome === "timeout") {
        throw new Error("daemon did not exit after stop");
    }
    return outcome;
};

/** Removes a temporary directory, retrying Windows handle-release races (antivirus, exe scans). */
const removeDirectory = async (directory: string): Promise<void> => {
    const retryableCodes = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);
    for (let attempt = 0; ; attempt += 1) {
        try {
            await rm(directory, { force: true, recursive: true });
            return;
        } catch (error) {
            const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
            if (attempt >= 9 || code === undefined || !retryableCodes.has(code)) {
                throw error;
            }
            await Bun.sleep(100 * (attempt + 1));
        }
    }
};

test("daemon artifact override rejects relative and missing paths", () => {
    expect(() => resolveArtifactPath({ ZED_HERDR_TEST_DIST: "dist/index.js" })).toThrow(
        "ZED_HERDR_TEST_DIST must be an absolute path",
    );
    expect(() =>
        resolveArtifactPath({
            ZED_HERDR_TEST_DIST: join(tmpdir(), `zed-herdr-missing-${crypto.randomUUID()}.js`),
        }),
    ).toThrow("Built daemon artifact does not exist");
});

const writeLogFailurePreload = async (directory: string): Promise<string> => {
    const path = join(directory, "fail-log.cjs");
    await writeFile(
        path,
        `
const fs = require("node:fs");
const write = fs.writeSync;
fs.writeSync = (...args) => {
    if (fs.existsSync(process.env.ZED_HERDR_LOG_FAILURE_TRIGGER)) {
        throw new Error("Injected daemon log disk failure");
    }
    return write(...args);
};
`,
    );
    return path;
};

test("built background daemon fails before readiness when its first log write fails", async () => {
    const artifact = resolveArtifactPath(process.env);
    const directory = await mkdtemp(join(tmpdir(), "zh-e2e-log-start-"));
    let daemon: Bun.Subprocess | undefined;
    try {
        const trigger = join(directory, "disk-failed");
        await writeFile(trigger, "");
        const preload = await writeLogFailurePreload(directory);
        const environment = {
            ...daemonEnvironment(directory, "zed"),
            ZED_HERDR_BACKGROUND: "1",
            ZED_HERDR_LOG_FAILURE_TRIGGER: trigger,
        };
        daemon = Bun.spawn([process.execPath, "--preload", preload, artifact, "daemon"], {
            env: environment,
            stdout: "ignore",
            stderr: "pipe",
            stdin: "ignore",
        });
        expect(await exitWithin(daemon, 5_000)).toBe(1);
        expect(
            await readFile(daemonLogPath(controlSocketPath(environment), environment), "utf8"),
        ).toBe("");
        expect((await runControlCommand(artifact, "health", environment)).exitCode).toBe(1);
    } finally {
        if (daemon !== undefined && daemon.exitCode === null) {
            daemon.kill();
            await daemon.exited;
        }
        await removeDirectory(directory);
    }
}, 10_000);

test("built background daemon closes its subscription and endpoint after a runtime log failure", async () => {
    const artifact = resolveArtifactPath(process.env);
    const directory = await mkdtemp(join(tmpdir(), "zh-e2e-log-runtime-"));
    const herdr = new HerdRServer(join(directory, "herdr.sock"));
    let daemon: Bun.Subprocess | undefined;
    try {
        const trigger = join(directory, "disk-failed");
        const preload = await writeLogFailurePreload(directory);
        const environment = {
            ...daemonEnvironment(directory, join(directory, "missing-zed")),
            ZED_HERDR_BACKGROUND: "1",
            ZED_HERDR_LOG_FAILURE_TRIGGER: trigger,
        };
        daemon = Bun.spawn([process.execPath, "--preload", preload, artifact, "daemon"], {
            env: environment,
            stdout: "ignore",
            stderr: "pipe",
            stdin: "ignore",
        });
        const state = singleWorkspaceSnapshot(directory);
        const initial = await herdr.nextRequest("session.snapshot");
        herdr.send(initial.socket, snapshotResponse(initial.request, state));
        const subscription = await herdr.nextRequest("events.subscribe");
        herdr.send(subscription.socket, subscriptionStarted(subscription.request));
        const authoritative = await herdr.nextRequest("session.snapshot");
        expect((await runControlCommand(artifact, "health", environment)).exitCode).toBe(0);
        await writeFile(trigger, "");
        herdr.send(authoritative.socket, snapshotResponse(authoritative.request, state));

        expect(await exitWithin(daemon, 5_000)).toBe(1);
        await herdr.waitForConnectionClose(subscription.socket);
        expect((await runControlCommand(artifact, "health", environment)).exitCode).toBe(1);
        const lines = (
            await readFile(daemonLogPath(controlSocketPath(environment), environment), "utf8")
        )
            .trim()
            .split("\n");
        expect(JSON.parse(lines[0]!).type).toBe("daemon_started");
        for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    } finally {
        if (daemon !== undefined && daemon.exitCode === null) {
            daemon.kill();
            await daemon.exited;
        }
        herdr.close();
        await removeDirectory(directory);
    }
}, 12_000);

test("built hooks and start share a detached daemon and replace it after an update", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zh-e2e-update-"));
    const artifact = join(directory, "bundle.js");
    const herdr = new HerdRServer(join(directory, "herdr.sock"));
    const recorder = new RecorderServer(join(directory, "recorder.sock"));
    let environment: NodeJS.ProcessEnv | undefined;
    try {
        await copyFile(resolveArtifactPath(process.env), artifact);
        const fakeZed = await writeFakeZed(directory);
        const checkout = join(directory, "project");
        await mkdir(checkout);
        environment = {
            ...daemonEnvironment(directory, fakeZed),
            ZED_HERDR_PROJECT_MODE: "directory",
            HERDR_PANE_ID: "unrelated-pane",
            HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
                data: { workspace: { workspace_id: "workspace-a" } },
            }),
            HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: checkout }),
        };
        const results = await Promise.all([
            runControlCommand(artifact, "hook", environment),
            runControlCommand(artifact, "hook", environment),
            runControlCommand(artifact, "start", environment),
        ]);
        for (const result of results) expect(result.exitCode).toBe(0);
        const health = JSON.parse(
            (await runControlCommand(artifact, "health", environment)).stdout,
        ).daemon;
        expect(health.paneId).toBeNull();
        const initial = await herdr.nextRequest("session.snapshot");
        const snapshotValue = singleWorkspaceSnapshot(checkout);
        herdr.send(initial.socket, snapshotResponse(initial.request, snapshotValue));
        const subscription = await herdr.nextRequest("events.subscribe");
        herdr.send(subscription.socket, subscriptionStarted(subscription.request));
        const authoritative = await herdr.nextRequest("session.snapshot");
        herdr.send(authoritative.socket, snapshotResponse(authoritative.request, snapshotValue));
        await recorder.waitForCount(2);
        expect(recorder.records.slice(0, 2)).toEqual([`-e ${checkout}`, `-e ${checkout}`]);
        expect((await runControlCommand(artifact, "stop", environment)).exitCode).toBe(0);
        await herdr.waitForConnectionClose();
        const logPath = daemonLogPath(controlSocketPath(environment), environment);
        const records = (await readFile(logPath, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        expect(JSON.stringify(records)).toContain("workspace_sync_succeeded");
        await copyFile(resolveArtifactPath(process.env), artifact);
        await appendFile(artifact, "\n// Updated bundle\n");
        const builtAt = Date.now();
        const restart = await runControlCommand(artifact, "start", environment);
        expect(restart.exitCode).toBe(0);
        const next = JSON.parse(
            (await runControlCommand(artifact, "health", environment)).stdout,
        ).daemon;
        expect(next.startedAt).not.toBe(health.startedAt);
        expect(Date.parse(next.startedAt)).toBeGreaterThanOrEqual(builtAt);
        const repeated = JSON.parse(
            (await runControlCommand(artifact, "start", environment)).stdout,
        );
        expect(repeated.daemon.pid).toBe(next.pid);
        expect(repeated.daemon.startedAt).toBe(next.startedAt);
    } finally {
        if (environment !== undefined) await runControlCommand(artifact, "stop", environment);
        recorder.close();
        herdr.close();
        await removeDirectory(directory);
    }
}, 30_000);

test(
    "built daemon gates editor activation through S1, subscription acknowledgement, and S2",
    async () => {
        const artifactPath = resolveArtifactPath(process.env);
        const directory = await mkdtemp(join(tmpdir(), "zh-e2e-"));
        const herdr = new HerdRServer(join(directory, "herdr.sock"));
        const recorder = new RecorderServer(join(directory, "recorder.sock"));
        const repoAPath = join(directory, "repo-a");
        const repoBPath = join(directory, "repo-b");
        let daemon: Bun.Subprocess | undefined;

        try {
            const fakeZed = await writeFakeZed(directory);
            const [repoA, repoB] = await Promise.all([
                createGitRepository(repoAPath),
                createGitRepository(repoBPath),
            ]);
            const focusedA = snapshot(repoA, repoB, "workspace-a");
            const focusedB = snapshot(repoA, repoB, "workspace-b");

            daemon = spawnDaemon(artifactPath, daemonEnvironment(directory, fakeZed));

            const initialSnapshot = await herdr.nextRequest("session.snapshot");
            herdr.send(initialSnapshot.socket, snapshotResponse(initialSnapshot.request, focusedA));

            const subscription = await herdr.nextRequest("events.subscribe");
            herdr.send(subscription.socket, subscriptionStarted(subscription.request));

            const firstAuthoritativeSnapshot = await herdr.nextRequest("session.snapshot");
            expect(recorder.records).toEqual([]);
            herdr.send(
                firstAuthoritativeSnapshot.socket,
                snapshotResponse(firstAuthoritativeSnapshot.request, focusedB),
            );

            await recorder.waitForCount(3);
            expect(recorder.records).toEqual([`-e ${repoA}`, `-e ${repoB}`, `-e ${repoB}`]);

            herdr.send(subscription.socket, focusedEvent("workspace-a"));
            const focusedASnapshot = await herdr.nextRequest("session.snapshot");
            herdr.send(
                focusedASnapshot.socket,
                snapshotResponse(focusedASnapshot.request, focusedA),
            );

            await recorder.waitForCount(4);
            expect(recorder.records).toEqual([
                `-e ${repoA}`,
                `-e ${repoB}`,
                `-e ${repoB}`,
                `-e ${repoA}`,
            ]);

            herdr.send(subscription.socket, focusedEvent("workspace-a"));
            const duplicateSnapshot = await herdr.nextRequest("session.snapshot");
            herdr.send(
                duplicateSnapshot.socket,
                snapshotResponse(duplicateSnapshot.request, focusedA),
            );
            herdr.writeRaw(
                subscription.socket,
                '{"event":"workspace_focused","data":{"type":"workspace_focused"}}\n',
            );
            herdr.send(subscription.socket, focusedEvent("workspace-b"));

            const interruptedSnapshot = await herdr.nextRequest("session.snapshot");
            expect(recorder.records).toEqual([
                `-e ${repoA}`,
                `-e ${repoB}`,
                `-e ${repoB}`,
                `-e ${repoA}`,
            ]);
            subscription.socket.end();
            void interruptedSnapshot;

            const reconnectInitialSnapshot = await herdr.nextRequest("session.snapshot");
            herdr.send(
                reconnectInitialSnapshot.socket,
                snapshotResponse(reconnectInitialSnapshot.request, focusedB),
            );
            const reconnectSubscription = await herdr.nextRequest("events.subscribe");
            herdr.send(
                reconnectSubscription.socket,
                subscriptionStarted(reconnectSubscription.request),
            );

            const reconnectAuthoritativeSnapshot = await herdr.nextRequest("session.snapshot");
            expect(recorder.records).toEqual([
                `-e ${repoA}`,
                `-e ${repoB}`,
                `-e ${repoB}`,
                `-e ${repoA}`,
            ]);
            herdr.send(
                reconnectAuthoritativeSnapshot.socket,
                snapshotResponse(reconnectAuthoritativeSnapshot.request, focusedB),
            );

            await recorder.waitForCount(5);
            expect(recorder.records).toEqual([
                `-e ${repoA}`,
                `-e ${repoB}`,
                `-e ${repoB}`,
                `-e ${repoA}`,
                `-e ${repoB}`,
            ]);

            await stopDaemon(daemon);
            daemon = undefined;
        } finally {
            if (daemon !== undefined && daemon.exitCode === null) {
                daemon.kill("SIGKILL");
                await daemon.exited;
            }
            recorder.close();
            herdr.close();
            await removeDirectory(directory);
        }
    },
    isWindows ? 30_000 : 15_000,
);

test(
    "built daemon in directory mode opens the checkout directory instead of its Git root",
    async () => {
        const artifactPath = resolveArtifactPath(process.env);
        const directory = await mkdtemp(join(tmpdir(), "zh-e2e-directory-"));
        const herdr = new HerdRServer(join(directory, "herdr.sock"));
        const recorder = new RecorderServer(join(directory, "recorder.sock"));
        let daemon: Bun.Subprocess | undefined;

        try {
            const fakeZed = await writeFakeZed(directory);
            const gitRoot = await createGitRepository(join(directory, "repo"));
            const checkout = join(gitRoot, "packages", "nested");
            await mkdir(checkout, { recursive: true });
            const authoritative = singleWorkspaceSnapshot(checkout);

            daemon = spawnDaemon(artifactPath, {
                ...daemonEnvironment(directory, fakeZed),
                ZED_HERDR_PROJECT_MODE: "directory",
            });

            const initialSnapshot = await herdr.nextRequest("session.snapshot");
            herdr.send(
                initialSnapshot.socket,
                snapshotResponse(initialSnapshot.request, authoritative),
            );

            const subscription = await herdr.nextRequest("events.subscribe");
            herdr.send(subscription.socket, subscriptionStarted(subscription.request));

            const authoritativeSnapshot = await herdr.nextRequest("session.snapshot");
            herdr.send(
                authoritativeSnapshot.socket,
                snapshotResponse(authoritativeSnapshot.request, authoritative),
            );

            await recorder.waitForCount(2);
            expect(recorder.records).toEqual([`-e ${checkout}`, `-e ${checkout}`]);
            expect(recorder.records).not.toContain(`-e ${gitRoot}`);
            expect(checkout.startsWith(gitRoot)).toBe(true);

            await stopDaemon(daemon);
            daemon = undefined;
        } finally {
            if (daemon !== undefined && daemon.exitCode === null) {
                daemon.kill("SIGKILL");
                await daemon.exited;
            }
            recorder.close();
            herdr.close();
            await removeDirectory(directory);
        }
    },
    isWindows ? 30_000 : 15_000,
);

test(
    "built daemon in directory mode opens a non-Git parent holding nested repositories",
    async () => {
        const artifactPath = resolveArtifactPath(process.env);
        const directory = await mkdtemp(join(tmpdir(), "zh-e2e-directory-parent-"));
        const herdr = new HerdRServer(join(directory, "herdr.sock"));
        const recorder = new RecorderServer(join(directory, "recorder.sock"));
        let daemon: Bun.Subprocess | undefined;

        try {
            const fakeZed = await writeFakeZed(directory);
            const workspace = join(directory, "workspace");
            await mkdir(workspace, { recursive: true });
            const [repoA, repoB] = await Promise.all([
                createGitRepository(join(workspace, "repo-a")),
                createGitRepository(join(workspace, "repo-b")),
            ]);
            expect(existsSync(join(workspace, ".git"))).toBe(false);
            const authoritative = singleWorkspaceSnapshot(workspace);

            daemon = spawnDaemon(artifactPath, {
                ...daemonEnvironment(directory, fakeZed),
                ZED_HERDR_PROJECT_MODE: "directory",
            });

            const initialSnapshot = await herdr.nextRequest("session.snapshot");
            herdr.send(
                initialSnapshot.socket,
                snapshotResponse(initialSnapshot.request, authoritative),
            );

            const subscription = await herdr.nextRequest("events.subscribe");
            herdr.send(subscription.socket, subscriptionStarted(subscription.request));

            const authoritativeSnapshot = await herdr.nextRequest("session.snapshot");
            herdr.send(
                authoritativeSnapshot.socket,
                snapshotResponse(authoritativeSnapshot.request, authoritative),
            );

            await recorder.waitForCount(2);
            expect(recorder.records).toEqual([`-e ${workspace}`, `-e ${workspace}`]);
            expect(recorder.records).not.toContain(`-e ${repoA}`);
            expect(recorder.records).not.toContain(`-e ${repoB}`);

            await stopDaemon(daemon);
            daemon = undefined;
        } finally {
            if (daemon !== undefined && daemon.exitCode === null) {
                daemon.kill("SIGKILL");
                await daemon.exited;
            }
            recorder.close();
            herdr.close();
            await removeDirectory(directory);
        }
    },
    isWindows ? 30_000 : 15_000,
);

test(
    "built daemon stops through the control CLI, releases its session, and restarts",
    async () => {
        const artifactPath = resolveArtifactPath(process.env);
        const directory = await mkdtemp(join(tmpdir(), "zh-e2e-stop-"));
        const herdr = new HerdRServer(join(directory, "herdr.sock"));
        const recorder = new RecorderServer(join(directory, "recorder.sock"));
        let daemon: Bun.Subprocess | undefined;

        try {
            const fakeZed = await writeFakeZed(directory);
            const environment = daemonEnvironment(directory, fakeZed);
            const repo = await createGitRepository(join(directory, "repo"));
            const authoritative = singleWorkspaceSnapshot(repo);

            const bootstrap = async (): Promise<void> => {
                const initial = await herdr.nextRequest("session.snapshot");
                herdr.send(initial.socket, snapshotResponse(initial.request, authoritative));
                const subscription = await herdr.nextRequest("events.subscribe");
                herdr.send(subscription.socket, subscriptionStarted(subscription.request));
                const settled = await herdr.nextRequest("session.snapshot");
                herdr.send(settled.socket, snapshotResponse(settled.request, authoritative));
            };

            daemon = spawnDaemon(artifactPath, environment);
            const firstPid = daemon.pid;
            await bootstrap();
            await recorder.waitForCount(1);

            const healthy = await runControlCommand(artifactPath, "health", environment);
            expect(healthy.exitCode).toBe(0);
            const health = JSON.parse(healthy.stdout) as { ok: boolean; daemon: { pid: number } };
            expect(health.ok).toBe(true);
            expect(health.daemon.pid).toBe(firstPid);

            // No signal, no external kill: the daemon acknowledges over its own
            // control endpoint and closes its scope in the documented order.
            const stopped = await runControlCommand(artifactPath, "stop", environment);
            expect(stopped.exitCode).toBe(0);
            expect(stopped.stderr).toBe("");
            const acknowledgement = JSON.parse(stopped.stdout) as {
                ok: boolean;
                daemon: { identity: string; pid: number; startedAt: string };
            };
            expect(acknowledgement.ok).toBe(true);
            expect(acknowledgement.daemon.identity).toBe("artisann.zed-herdr:daemon");
            expect(acknowledgement.daemon.pid).toBe(firstPid);
            expect(Number.isNaN(Date.parse(acknowledgement.daemon.startedAt))).toBe(false);

            const exited = await exitWithin(daemon, 15_000);
            await herdr.waitForConnectionClose();
            expect(exited).toBe(0);
            daemon = undefined;

            // The endpoint is gone with the process, so a second command cannot
            // revive a stopped daemon.
            const orphaned = await runControlCommand(artifactPath, "health", environment);
            expect(orphaned.exitCode).toBe(1);
            expect(orphaned.stdout).toBe("");

            // The same session accepts a fresh daemon: stop only ended one cycle.
            daemon = spawnDaemon(artifactPath, environment);
            const secondPid = daemon.pid;
            expect(secondPid).not.toBe(firstPid);
            await bootstrap();

            const restarted = await runControlCommand(artifactPath, "health", environment);
            expect(restarted.exitCode).toBe(0);
            const restartedHealth = JSON.parse(restarted.stdout) as {
                daemon: { pid: number };
            };
            expect(restartedHealth.daemon.pid).toBe(secondPid);

            const stoppedAgain = await runControlCommand(artifactPath, "stop", environment);
            expect(stoppedAgain.exitCode).toBe(0);
            expect(
                (JSON.parse(stoppedAgain.stdout) as { daemon: { pid: number } }).daemon.pid,
            ).toBe(secondPid);
            expect(await exitWithin(daemon, 15_000)).toBe(0);
            daemon = undefined;
        } finally {
            if (daemon !== undefined && daemon.exitCode === null) {
                daemon.kill("SIGKILL");
                await daemon.exited;
            }
            recorder.close();
            herdr.close();
            await removeDirectory(directory);
        }
    },
    isWindows ? 45_000 : 20_000,
);
