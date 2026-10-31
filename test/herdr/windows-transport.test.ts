import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { makeHerdRClient } from "../../src/herdr/client.ts";
import { NdjsonDecoder } from "../../src/herdr/ndjson.ts";
import {
    MINIMUM_HERDR_PROTOCOL,
    makeEventsSubscribeRequest,
    makeSessionSnapshotRequest,
} from "../../src/herdr/protocol.ts";
import {
    connectHerdRChannel,
    HERDR_NAMED_PIPE_PREFIX,
    resolveHerdRSocketPath,
    toHerdRNamedPipePath,
    type HerdRChannel,
    type HerdRChannelHandlers,
} from "../../src/herdr/windows-transport.ts";

/**
 * Named pipes are a Windows-only transport; the pure derivation tests below still run
 * everywhere because they take an explicit platform and environment.
 */
const isWindows = process.platform === "win32";
const windowsTest = isWindows ? test : test.skip;

/**
 * Checks that talk to a real daemon are opt-in, so the standard suite never depends on a
 * running HerdR or on a leftover marker file: `ZED_HERDR_TEST_LIVE=1 bun test ...`.
 */
const liveWindowsTest = isWindows && process.env.ZED_HERDR_TEST_LIVE === "1" ? test : test.skip;

const LIVE_TEST_TIMEOUT_MS = 30_000;

const silentHandlers = (): HerdRChannelHandlers => ({
    close: () => {},
    data: () => {},
    end: () => {},
    error: () => {},
});

test("resolveHerdRSocketPath keeps the Unix layout unchanged", () => {
    expect(
        resolveHerdRSocketPath(
            { HERDR_SESSION: "named", HERDR_SOCKET_PATH: "/run/custom.sock" },
            "linux",
        ),
    ).toBe("/run/custom.sock");
    expect(
        resolveHerdRSocketPath({ HERDR_SESSION: "named", XDG_CONFIG_HOME: "/config" }, "linux"),
    ).toBe("/config/herdr/sessions/named/herdr.sock");
    expect(resolveHerdRSocketPath({ HOME: "/home/u" }, "linux")).toBe(
        "/home/u/.config/herdr/herdr.sock",
    );
    expect(resolveHerdRSocketPath({ HERDR_SESSION: "named", HOME: "/home/u" }, "darwin")).toBe(
        "/home/u/.config/herdr/sessions/named/herdr.sock",
    );
});

test("resolveHerdRSocketPath uses the HerdR Windows config directory", () => {
    const appData = { APPDATA: "C:\\Users\\u\\AppData\\Roaming" };

    expect(resolveHerdRSocketPath(appData, "win32")).toBe(
        "C:\\Users\\u\\AppData\\Roaming\\herdr\\herdr.sock",
    );
    expect(resolveHerdRSocketPath({ ...appData, HERDR_SESSION: "named" }, "win32")).toBe(
        "C:\\Users\\u\\AppData\\Roaming\\herdr\\sessions\\named\\herdr.sock",
    );
    expect(
        resolveHerdRSocketPath({ ...appData, HERDR_SOCKET_PATH: "D:\\pipes\\herdr.sock" }, "win32"),
    ).toBe("D:\\pipes\\herdr.sock");
});

test("resolveHerdRSocketPath prefers XDG_CONFIG_HOME and falls back to the profile", () => {
    expect(
        resolveHerdRSocketPath({ APPDATA: "C:\\appdata", XDG_CONFIG_HOME: "C:\\cfg" }, "win32"),
    ).toBe("C:\\cfg\\herdr\\herdr.sock");
    expect(resolveHerdRSocketPath({ USERPROFILE: "C:\\Users\\u" }, "win32")).toBe(
        "C:\\Users\\u\\AppData\\Roaming\\herdr\\herdr.sock",
    );
    expect(resolveHerdRSocketPath({ HOME: "/home/u" }, "win32")).toBe(
        "/home/u\\.config\\herdr\\herdr.sock",
    );
});

test("toHerdRNamedPipePath keeps the socket path verbatim after the pipe prefix", () => {
    expect(HERDR_NAMED_PIPE_PREFIX).toBe("\\\\.\\pipe\\");
    expect(toHerdRNamedPipePath("C:\\Users\\u\\AppData\\Roaming\\herdr\\herdr.sock")).toBe(
        "\\\\.\\pipe\\C:\\Users\\u\\AppData\\Roaming\\herdr\\herdr.sock",
    );
    expect(toHerdRNamedPipePath("C:/Users/u/herdr.sock")).toBe(
        "\\\\.\\pipe\\C:/Users/u/herdr.sock",
    );
    expect(
        toHerdRNamedPipePath(
            resolveHerdRSocketPath({ APPDATA: "C:\\appdata", HERDR_SESSION: "named" }, "win32"),
        ),
    ).toBe("\\\\.\\pipe\\C:\\appdata\\herdr\\sessions\\named\\herdr.sock");
});

test("toHerdRNamedPipePath rejects empty and NUL-containing paths", () => {
    expect(() => toHerdRNamedPipePath("")).toThrow(TypeError);
    expect(() => toHerdRNamedPipePath("C:\\herdr\0.sock")).toThrow(RangeError);
});

windowsTest("connectHerdRChannel exchanges NDJSON over a named pipe", async () => {
    const name = `zed-herdr-test-${crypto.randomUUID()}`;
    const peerDecoder = new NdjsonDecoder();
    const received: Array<string> = [];
    const peerClosed = Promise.withResolvers<void>();
    const listener = Bun.listen<undefined>({
        socket: {
            data: (socket, data) => {
                for (const frame of peerDecoder.push(data)) {
                    if (frame.length === 0) {
                        continue;
                    }
                    received.push(frame);
                    const request = JSON.parse(frame) as { readonly id: string };
                    socket.write(
                        `${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`,
                    );
                }
            },
            open: () => {},
            close: () => {
                peerClosed.resolve();
            },
        },
        unix: `${HERDR_NAMED_PIPE_PREFIX}${name}`,
    });

    const clientDecoder = new NdjsonDecoder();
    const acknowledged = Promise.withResolvers<string>();
    let channel: HerdRChannel | null = null;

    try {
        channel = await connectHerdRChannel(name, {
            ...silentHandlers(),
            data: (chunk) => {
                for (const frame of clientDecoder.push(chunk)) {
                    acknowledged.resolve(frame);
                }
            },
        });

        channel.write(`${JSON.stringify(makeEventsSubscribeRequest("sub-1", 22))}\n`);
        const frame = await acknowledged.promise;
        expect(JSON.parse(frame)).toMatchObject({
            id: "sub-1",
            result: { type: "subscription_started" },
        });
        expect(received).toEqual([JSON.stringify(makeEventsSubscribeRequest("sub-1", 22))]);

        channel.terminate();
        channel = null;
        await Promise.race([
            peerClosed.promise,
            Bun.sleep(2_000).then(() => {
                throw new Error("named-pipe peer did not observe the close");
            }),
        ]);
    } finally {
        channel?.terminate();
        listener.stop(true);
    }
});

windowsTest("connectHerdRChannel names the derived pipe when no server is listening", async () => {
    const socketPath = `C:\\missing-${crypto.randomUUID()}\\herdr.sock`;
    let failure: Error | null = null;
    try {
        await connectHerdRChannel(socketPath, silentHandlers());
    } catch (cause) {
        failure = cause as Error;
    }

    expect(failure).not.toBeNull();
    expect(failure?.message).toContain(
        `HerdR named pipe unavailable: ${toHerdRNamedPipePath(socketPath)} (ENOENT)`,
    );
});

liveWindowsTest(
    "reads a live read-only HerdR snapshot and subscription over the named pipe",
    async () => {
        const observed = await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const client = yield* makeHerdRClient(process.env);
                    const invalidated = yield* client.events.pipe(
                        Stream.filter((event) => event._tag === "Invalidated"),
                        Stream.take(1),
                        Stream.runHead,
                    );
                    const generation = Option.getOrThrow(invalidated).generation;
                    const projected = yield* client.snapshot(generation);
                    return {
                        protocol: client.protocolStatus().protocol,
                        workspaces: projected.workspaces.length,
                    };
                }),
            ).pipe(Effect.timeout("20 seconds")),
        );

        expect(observed.protocol).toBeGreaterThanOrEqual(MINIMUM_HERDR_PROTOCOL);
        expect(observed.workspaces).toBeGreaterThanOrEqual(0);
    },
    LIVE_TEST_TIMEOUT_MS,
);

liveWindowsTest(
    "reads a live HerdR snapshot reply through a single named-pipe request",
    async () => {
        const socketPath = resolveHerdRSocketPath(process.env);
        const decoder = new NdjsonDecoder();
        const answered = Promise.withResolvers<string>();
        const request = makeSessionSnapshotRequest("snapshot-1");
        let channel: HerdRChannel | null = null;

        try {
            channel = await connectHerdRChannel(socketPath, {
                ...silentHandlers(),
                data: (chunk) => {
                    for (const frame of decoder.push(chunk)) {
                        answered.resolve(frame);
                    }
                },
            });

            channel.write(`${JSON.stringify(request)}\n`);
            const reply = JSON.parse(await answered.promise) as {
                readonly result: {
                    readonly type: string;
                    readonly snapshot: { readonly protocol: number };
                };
            };
            expect(reply.result.type).toBe("session_snapshot");
            expect(reply.result.snapshot.protocol).toBeGreaterThanOrEqual(MINIMUM_HERDR_PROTOCOL);
        } finally {
            channel?.terminate();
        }
    },
    LIVE_TEST_TIMEOUT_MS,
);
