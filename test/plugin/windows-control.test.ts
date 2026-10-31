import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";

import * as Schema from "effect/Schema";

import {
    AlreadyRunning,
    CONTROL_DAEMON_IDENTITY,
    ControlUnavailable,
    UnsafeControlSocket,
    controlLockPath,
    controlSocketPath,
    healthControl,
    notifyControl,
    prepareControlSocket,
    prepareControlSocketDirectory,
    startControlServer,
    toggleControl,
    type ControlServer,
} from "../../src/plugin/control.ts";
import {
    HookNotification,
    type HookNotification as HookNotificationValue,
} from "../../src/plugin/protocol.ts";
import {
    classifyWindowsControlStartError,
    currentWindowsUserSid,
    isWindowsControlPipePath,
    windowsControlPipePath,
    windowsPipePresence,
} from "../../src/plugin/windows-pipe.ts";

const windowsTest = test.skipIf(process.platform !== "win32");

const uniquePipe = (): string =>
    windowsControlPipePath(randomUUID().replaceAll("-", "").slice(0, 16));

const digestOf = (value: string): string =>
    createHash("sha256").update(value).digest("hex").slice(0, 16);

const hint: HookNotificationValue = Schema.decodeUnknownSync(HookNotification)({
    workspaceId: "ws-1",
    cwd: "C:\\repos\\one",
});

const startServer = async (
    path: string,
    published: Array<HookNotificationValue> = [],
    paneId: string | null = "pane-1",
): Promise<ControlServer> =>
    await startControlServer({
        path,
        paneId,
        notifications: {
            publish(notification) {
                published.push(notification);
            },
        },
        toggleEnabled: () => true,
        protocolStatus: () => ({ protocol: 22, beyondTested: false }),
    });

/**
 * One raw single-frame exchange, so wire framing is asserted without the CLI
 * helpers. Without `end` the server is still waiting for a newline, which must
 * not produce a response.
 */
const exchange = async (path: string, frame: Uint8Array): Promise<string> => {
    const chunks: Array<Uint8Array> = [];
    let closed = false;
    const socket = await Bun.connect({
        unix: path,
        socket: {
            data(_socket, chunk) {
                chunks.push(new Uint8Array(chunk));
            },
            close() {
                closed = true;
            },
            error() {},
        },
    });
    try {
        socket.write(frame);
        for (let attempt = 0; attempt < 200 && chunks.length === 0 && !closed; attempt += 1) {
            await Bun.sleep(5);
        }
        return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
    } finally {
        socket.end();
    }
};

windowsTest("derives a stable per-session, per-account named pipe", () => {
    const sid = currentWindowsUserSid();
    if (sid === undefined) {
        // The owner-scoped name intentionally has no fallback: without a SID the
        // derivation fails closed, so this test cannot invent one.
        expect(() => controlSocketPath({ HERDR_SOCKET_PATH: "\\\\.\\pipe\\herdr-1" })).toThrow();
        return;
    }
    const socket = "\\\\.\\pipe\\herdr-1234-5678";
    const path = controlSocketPath({ HERDR_SOCKET_PATH: socket });
    expect(isWindowsControlPipePath(path)).toBe(true);
    // The account SID is part of the digest, so two accounts never share a name
    // and the name is not derivable from the HerdR path alone.
    expect(path).toBe(`\\\\.\\pipe\\zed-herdr-${digestOf(`${sid}\u0000${socket}`)}`);
    expect(path).not.toBe(`\\\\.\\pipe\\zed-herdr-${digestOf(socket)}`);
    expect(controlSocketPath({ HERDR_SOCKET_PATH: socket })).toBe(path);

    const configured = { XDG_CONFIG_HOME: "C:\\Users\\someone\\AppData\\Roaming" };
    const alpha = controlSocketPath({ ...configured, HERDR_SESSION: "alpha" });
    const beta = controlSocketPath({ ...configured, HERDR_SESSION: "beta" });
    expect(alpha).not.toBe(beta);
    expect(isWindowsControlPipePath(alpha)).toBe(true);
});

windowsTest("keys the hook lock by endpoint under the per-user state root", () => {
    const path = uniquePipe();
    expect(controlLockPath(path, { LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local" })).toBe(
        `C:\\Users\\someone\\AppData\\Local\\zed-herdr\\locks\\${digestOf(path)}.lock`,
    );
    // A shared temp directory is never used for the lock: another account could
    // create or replace the file there.
    expect(controlLockPath(path, { USERPROFILE: "C:\\Users\\someone" })).toBe(
        `C:\\Users\\someone\\AppData\\Local\\zed-herdr\\locks\\${digestOf(path)}.lock`,
    );
    expect(() => controlLockPath(path, {})).toThrow(UnsafeControlSocket);
    expect(() => controlLockPath(path, { TEMP: "C:\\Windows\\Temp" })).toThrow(UnsafeControlSocket);
    expect(() =>
        controlLockPath(path, { TEMP: "C:\\Windows\\Temp", TMP: "C:\\Windows\\Temp" }),
    ).toThrow(UnsafeControlSocket);
});

windowsTest("refuses a control path that is not the derived named pipe", async () => {
    await expect(prepareControlSocketDirectory("C:\\temp\\control.sock")).rejects.toBeInstanceOf(
        UnsafeControlSocket,
    );
    await expect(prepareControlSocket("C:\\temp\\control.sock")).rejects.toMatchObject({
        reason: "not_socket",
    });
});

windowsTest("serves health, toggle, and notifications over the named pipe", async () => {
    const path = uniquePipe();
    const published: Array<HookNotificationValue> = [];
    expect(await windowsPipePresence(path)).toBe("absent");
    await expect(prepareControlSocket(path)).resolves.toBeUndefined();

    const server = await startServer(path, published);
    try {
        expect(await windowsPipePresence(path)).toBe("present");
        expect(await healthControl(path)).toMatchObject({
            identity: "artisann.zed-herdr:daemon",
            paneId: "pane-1",
            protocol: 22,
            beyondTested: false,
        });
        expect(await toggleControl(path)).toBe(true);
        await notifyControl(path, hint);
        expect(published).toEqual([hint]);
    } finally {
        await server.close();
    }

    expect(await windowsPipePresence(path)).toBe("absent");
    await expect(healthControl(path)).rejects.toBeInstanceOf(ControlUnavailable);
});

windowsTest("fails closed when a daemon already bound the pipe name", async () => {
    const path = uniquePipe();
    const server = await startServer(path, [], null);
    try {
        await expect(startServer(path, [], "pane-2")).rejects.toBeInstanceOf(AlreadyRunning);
        await expect(prepareControlSocket(path)).rejects.toBeInstanceOf(AlreadyRunning);
    } finally {
        await server.close();
    }
    expect(await windowsPipePresence(path)).toBe("absent");
});

windowsTest("rejects trailing bytes and unterminated frames on the pipe", async () => {
    const path = uniquePipe();
    const published: Array<HookNotificationValue> = [];
    const server = await startServer(path, published);
    try {
        expect(
            await exchange(
                path,
                new TextEncoder().encode('{"type":"health"}\n{"type":"health"}\n'),
            ),
        ).toBe('{"ok":false,"error":"invalid_request"}\n');
        expect(await exchange(path, new TextEncoder().encode('{"type":"health"}'))).toBe("");
        expect(published).toEqual([]);
    } finally {
        await server.close();
    }
});

windowsTest("rejects fatal UTF-8 and oversized frames on the pipe", async () => {
    const path = uniquePipe();
    const published: Array<HookNotificationValue> = [];
    const server = await startServer(path, published);
    try {
        expect(await exchange(path, new Uint8Array([0xff, 0xfe, 0x0a]))).toBe(
            '{"ok":false,"error":"invalid_request"}\n',
        );

        const oversized = `{"type":"notify","notification":{"workspaceId":"ws-1","cwd":"${"c".repeat(64 * 1024)}"}}\n`;
        expect(await exchange(path, new TextEncoder().encode(oversized))).toBe(
            '{"ok":false,"error":"payload_too_large"}\n',
        );
        expect(published).toEqual([]);
    } finally {
        await server.close();
    }
});

windowsTest("answers a complete frame even when the client half-closes", async () => {
    const path = uniquePipe();
    const server = await startServer(path);
    try {
        const chunks: Array<Uint8Array> = [];
        let closed = false;
        const socket = await Bun.connect({
            unix: path,
            socket: {
                data(_socket, chunk) {
                    chunks.push(new Uint8Array(chunk));
                },
                close() {
                    closed = true;
                },
                error() {},
            },
        });
        socket.write(new TextEncoder().encode('{"type":"health"}\n'));
        // Bun drops an unflushed named-pipe write when `end()` immediately
        // follows it, so let the frame reach the server before closing.
        await Bun.sleep(20);
        socket.end();
        for (let attempt = 0; attempt < 200 && chunks.length === 0 && !closed; attempt += 1) {
            await Bun.sleep(5);
        }
        expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")).not.toBe(
            "",
        );
    } finally {
        await server.close();
    }
});

windowsTest("reports an absent pipe as unavailable instead of probing it", async () => {
    const path = uniquePipe();
    await expect(notifyControl(path, hint, 100)).rejects.toMatchObject({ operation: "connect" });
});

windowsTest("is connectable as soon as the server resolves", async () => {
    // A freshly bound pipe can report EBUSY for a few milliseconds; startup must
    // not resolve until the endpoint is visible, or the next health call fails.
    for (let iteration = 0; iteration < 5; iteration += 1) {
        const path = uniquePipe();
        const server = await startServer(path);
        try {
            const health = await healthControl(path);
            expect(health.identity).toBe(CONTROL_DAEMON_IDENTITY);
        } finally {
            await server.close();
        }
    }
});

windowsTest("classifies a bind failure without inventing success", () => {
    expect(
        classifyWindowsControlStartError(Object.assign(new Error("busy"), { code: "EADDRINUSE" })),
    ).toBe("already_running");
    expect(
        classifyWindowsControlStartError(Object.assign(new Error("busy"), { code: "EBUSY" })),
    ).toBe("already_running");
    expect(
        classifyWindowsControlStartError(Object.assign(new Error("denied"), { code: "EACCES" })),
    ).toBe("occupied");
    expect(classifyWindowsControlStartError(new Error("unexpected"))).toBe("occupied");
});

windowsTest("delivers the whole stop acknowledgement over the pipe before shutdown", async () => {
    const path = uniquePipe();
    let stops = 0;
    const server = await startControlServer({
        path,
        paneId: "pane-1",
        notifications: { async publish() {} },
        protocolStatus: () => ({ protocol: 22, beyondTested: false }),
        stopRequested() {
            stops += 1;
        },
    });

    try {
        const request = JSON.stringify({
            type: "stop",
            daemon: {
                identity: server.daemon.identity,
                pid: server.daemon.pid,
                startedAt: server.daemon.startedAt,
            },
        });
        const response = await exchange(path, new TextEncoder().encode(`${request}\n`));
        expect(response).toBe(
            `${JSON.stringify({ ok: true, stopping: true, daemon: server.daemon })}\n`,
        );
        for (let attempt = 0; attempt < 100 && stops === 0; attempt += 1) {
            await Bun.sleep(5);
        }
        expect(stops).toBe(1);

        // A pipe that answered a stop is still healthy until the owner closes it.
        expect((await healthControl(path)).pid).toBe(server.daemon.pid);
    } finally {
        await server.close();
    }
});
