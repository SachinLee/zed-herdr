import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
    chmod,
    chown,
    link,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    unlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as Schema from "effect/Schema";

import { HookNotification } from "../../src/plugin/protocol.ts";
import {
    AlreadyRunning,
    CONTROL_SOCKET_MAX_BYTES,
    CONTROL_SOCKET_MODE,
    ControlProtocolError,
    ControlUnavailable,
    UnsafeControlSocket,
    controlSocketPath,
    healthControl,
    notifyControl,
    prepareControlSocket,
    prepareControlSocketDirectory,
    probeControlSocket,
    startControlServer,
    stopControl,
    toggleControl,
} from "../../src/plugin/control.ts";
import { isWindowsControlPlatform } from "../../src/plugin/windows-pipe.ts";

const isWindows = isWindowsControlPlatform();
const posixTest = test.skipIf(isWindows);

const makeTemporaryDirectory = (): Promise<string> => mkdtemp(`${tmpdir()}/zed-herdr-control-`);

/**
 * A control endpoint that works on both platforms: a filesystem socket path on
 * POSIX, a freshly derived named pipe on Windows. Pipe names are global, so the
 * per-test directory hash keeps concurrent suites from colliding.
 */
const controlPathFor = (directory: string, name = "control"): string =>
    isWindows
        ? `\\\\.\\pipe\\zed-herdr-${createHash("sha256")
              .update(`${directory}/${name}`)
              .digest("hex")
              .slice(0, 16)}`
        : `${directory}/${name}.sock`;

const rawRequest = async (
    path: string,
    chunks: ReadonlyArray<string | Uint8Array>,
): Promise<string> =>
    new Promise<string>((resolveResponse, rejectResponse) => {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const requestGroups = chunks.map((chunk) => {
            const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
            const parts: Array<Uint8Array> = [];
            for (let offset = 0; offset < bytes.byteLength; offset += 8 * 1024) {
                parts.push(bytes.slice(offset, offset + 8 * 1024));
            }
            return parts;
        });
        let buffer = "";
        let groupIndex = 0;
        let chunkIndex = 0;
        let chunkOffset = 0;
        let settled = false;
        const finish = (operation: () => void): void => {
            if (!settled) {
                settled = true;
                operation();
            }
        };
        const finishResponse = (): void => {
            try {
                buffer += decoder.decode();
            } catch (error) {
                finish(() => rejectResponse(error));
                return;
            }
            if (!buffer.endsWith("\n")) {
                finish(() =>
                    rejectResponse(new Error("control socket ended without a response frame")),
                );
                return;
            }
            finish(() => resolveResponse(buffer.slice(0, -1)));
        };
        const writeRequest = (socket: Bun.Socket<undefined>): void => {
            while (groupIndex < requestGroups.length) {
                const requestGroup = requestGroups[groupIndex];
                if (requestGroup === undefined) {
                    return;
                }
                while (chunkIndex < requestGroup.length) {
                    const chunk = requestGroup[chunkIndex];
                    if (chunk === undefined) {
                        return;
                    }
                    const written = socket.write(chunk, chunkOffset);
                    if (written < 0) {
                        finish(() =>
                            rejectResponse(new Error("control socket closed while writing")),
                        );
                        return;
                    }
                    chunkOffset += written;
                    if (chunkOffset < chunk.byteLength) {
                        return;
                    }
                    chunkIndex += 1;
                    chunkOffset = 0;
                }
                groupIndex += 1;
                chunkIndex = 0;
            }
        };

        void Bun.connect({
            unix: path,
            allowHalfOpen: true,
            socket: {
                data(_socket, chunk) {
                    try {
                        buffer += decoder.decode(chunk, { stream: true });
                    } catch (error) {
                        finish(() => rejectResponse(error));
                    }
                },
                end() {
                    finishResponse();
                },
                drain(socket) {
                    writeRequest(socket);
                },
                close(_socket, error) {
                    if (error !== null && error !== undefined) {
                        finish(() => rejectResponse(error));
                    } else {
                        finishResponse();
                    }
                },
                error(_socket, error) {
                    finish(() => rejectResponse(error));
                },
            },
        }).then(writeRequest, (error: unknown) => finish(() => rejectResponse(error)));
    });

const withControlServer = async (
    body: (
        path: string,
        notifications: Array<HookNotification>,
        setProtocolStatus: (protocol: number | null, beyondTested: boolean) => void,
    ) => Promise<void>,
): Promise<void> => {
    const directory = await makeTemporaryDirectory();
    const path = controlPathFor(directory);
    const notifications: Array<HookNotification> = [];
    let enabled = true;
    let protocolStatus = { protocol: null as number | null, beyondTested: false };
    const server = await startControlServer({
        path,
        paneId: "daemon-pane",
        notifications: {
            async publish(notification) {
                notifications.push(notification);
            },
        },
        toggleEnabled() {
            enabled = !enabled;
            return enabled;
        },
        protocolStatus: () => protocolStatus,
    });

    try {
        await body(path, notifications, (protocol, beyondTested) => {
            protocolStatus = { protocol, beyondTested };
        });
    } finally {
        await server.close();
        await rm(directory, { force: true, recursive: true });
    }
};

posixTest("derives XDG and HerdR-directory control socket paths", () => {
    const herdRSocket = "/tmp/../tmp/herdr/session.sock";
    const resolvedHerdRSocket = resolve(herdRSocket);
    const digest = createHash("sha256").update(resolvedHerdRSocket).digest("hex").slice(0, 16);

    expect(
        controlSocketPath({
            HERDR_SOCKET_PATH: herdRSocket,
            XDG_RUNTIME_DIR: "/runtime/user",
        }),
    ).toBe(join("/runtime/user", "zed-herdr", `${digest}.sock`));
    expect(controlSocketPath({ HERDR_SOCKET_PATH: herdRSocket })).toBe(
        join(dirname(resolvedHerdRSocket), "zed-herdr", `${digest}.sock`),
    );
});

posixTest("creates and tightens the owner-only control socket directory", async () => {
    const root = await makeTemporaryDirectory();
    const parent = join(root, "runtime");
    const directory = join(parent, "zed-herdr");
    const path = join(directory, "control.sock");
    const uid = process.getuid?.();

    try {
        await mkdir(parent, { mode: 0o700 });
        await chmod(parent, 0o700);
        await prepareControlSocketDirectory(path);
        expect((await lstat(directory)).isDirectory()).toBe(true);
        expect((await lstat(directory)).mode & 0o777).toBe(0o700);
        if (uid !== undefined) {
            expect((await lstat(directory)).uid).toBe(uid);
        }

        await chmod(directory, 0o755);
        await prepareControlSocketDirectory(path);
        expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

posixTest(
    "rejects control directories beneath unsafe parents and unsafe directory entries",
    async () => {
        const root = await makeTemporaryDirectory();
        const unsafeParent = join(root, "unsafe-parent");
        const safeChild = join(unsafeParent, "zed-herdr");
        const safeParent = join(root, "safe-parent");
        const target = join(root, "target");
        const symlinkedChild = join(safeParent, "zed-herdr");

        try {
            await mkdir(unsafeParent, { mode: 0o777 });
            await chmod(unsafeParent, 0o777);
            await mkdir(safeChild, { mode: 0o700 });
            await chmod(safeChild, 0o700);
            await expect(
                prepareControlSocketDirectory(join(safeChild, "existing-child.sock")),
            ).rejects.toMatchObject({
                _tag: "UnsafeControlSocket",
                reason: "unsafe_parent",
            } satisfies Partial<UnsafeControlSocket>);
            await rm(safeChild, { force: true, recursive: true });
            await expect(
                prepareControlSocketDirectory(
                    join(unsafeParent, "zed-herdr", "missing-child.sock"),
                ),
            ).rejects.toMatchObject({
                _tag: "UnsafeControlSocket",
                reason: "unsafe_parent",
            } satisfies Partial<UnsafeControlSocket>);

            await mkdir(safeParent, { mode: 0o700 });
            await chmod(safeParent, 0o700);
            await mkdir(target, { mode: 0o700 });
            await chmod(target, 0o700);
            await symlink(target, symlinkedChild);
            await expect(
                prepareControlSocketDirectory(join(symlinkedChild, "symlink.sock")),
            ).rejects.toMatchObject({
                _tag: "UnsafeControlSocket",
                reason: "symlink",
            } satisfies Partial<UnsafeControlSocket>);
            await unlink(symlinkedChild);
            await writeFile(symlinkedChild, "not a directory", { mode: 0o600 });
            await expect(
                prepareControlSocketDirectory(join(symlinkedChild, "file.sock")),
            ).rejects.toMatchObject({
                _tag: "UnsafeControlSocket",
                reason: "not_directory",
            } satisfies Partial<UnsafeControlSocket>);
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    },
);

posixTest(
    "rejects a foreign-owned control socket directory when ownership can be changed",
    async () => {
        const uid = process.getuid?.();
        if (uid !== 0) {
            return;
        }

        const root = await makeTemporaryDirectory();
        const parent = join(root, "runtime");
        const directory = join(parent, "zed-herdr");
        const path = join(directory, "control.sock");

        try {
            await mkdir(parent, { mode: 0o700 });
            await chmod(parent, 0o700);
            await mkdir(directory, { mode: 0o700 });
            await chmod(directory, 0o700);
            await chown(directory, 1, -1);
            await expect(prepareControlSocketDirectory(path)).rejects.toMatchObject({
                _tag: "UnsafeControlSocket",
                reason: "foreign_owner",
            } satisfies Partial<UnsafeControlSocket>);
        } finally {
            await chown(directory, uid, -1).catch(() => undefined);
            await rm(root, { force: true, recursive: true });
        }
    },
);

test("returns exact health and notify responses without trusting client pane fields", async () => {
    await withControlServer(async (path, notifications, setProtocolStatus) => {
        setProtocolStatus(22, false);
        const health = await rawRequest(path, [
            JSON.stringify({ type: "health", paneId: "attacker-pane" }),
            "\n",
        ]);
        const decodedHealth = JSON.parse(health) as {
            readonly ok: boolean;
            readonly daemon: {
                readonly identity: string;
                readonly paneId: string;
                readonly pid: number;
                readonly startedAt: string;
                readonly protocol: number | null;
                readonly beyondTested: boolean;
            };
        };
        expect(decodedHealth.ok).toBe(true);
        expect(decodedHealth.daemon.identity).toBe("artisann.zed-herdr:daemon");
        expect(decodedHealth.daemon.paneId).toBe("daemon-pane");
        expect(decodedHealth.daemon.pid).toBe(process.pid);
        expect(decodedHealth.daemon.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(decodedHealth.daemon.protocol).toBe(22);
        expect(decodedHealth.daemon.beyondTested).toBe(false);

        expect(
            JSON.parse(await rawRequest(path, [JSON.stringify({ type: "health" }), "\r\n"])),
        ).toEqual(decodedHealth);

        const notification = Schema.decodeUnknownSync(HookNotification)({
            workspaceId: "workspace-1",
            cwd: "/repo/one",
        });
        expect(
            await rawRequest(path, [JSON.stringify({ type: "notify", notification }), "\n"]),
        ).toBe('{"ok":true}');
        await notifyControl(path, notification);
        expect(notifications).toEqual([notification, notification]);
        expect(await toggleControl(path)).toBe(false);
        expect(await rawRequest(path, [JSON.stringify({ type: "toggle" }), "\n"])).toBe(
            '{"ok":true,"enabled":true}',
        );

        setProtocolStatus(23, true);
        const daemon = await healthControl(path);
        expect(daemon).toMatchObject({
            identity: "artisann.zed-herdr:daemon",
            paneId: "daemon-pane",
            pid: process.pid,
            protocol: 23,
            beyondTested: true,
        });
    });
});

test("incrementally decodes split unicode requests on concurrent sockets", async () => {
    await withControlServer(async (path, notifications) => {
        const first = JSON.stringify({
            type: "notify",
            notification: { workspaceId: "first", cwd: "/repo/😀" },
        });
        const second = JSON.stringify({
            type: "notify",
            notification: { workspaceId: "second", cwd: "/repo/é" },
        });
        const firstBytes = new TextEncoder().encode(`${first}\n`);
        const secondBytes = new TextEncoder().encode(`${second}\n`);

        const [firstResponse, secondResponse] = await Promise.all([
            rawRequest(path, [firstBytes.slice(0, firstBytes.length - 2), firstBytes.slice(-2)]),
            rawRequest(path, [secondBytes.slice(0, secondBytes.length - 1), secondBytes.slice(-1)]),
        ]);
        expect(firstResponse).toBe('{"ok":true}');
        expect(secondResponse).toBe('{"ok":true}');
        expect(notifications).toContainEqual(
            Schema.decodeUnknownSync(HookNotification)({ workspaceId: "first", cwd: "/repo/😀" }),
        );
        expect(notifications).toContainEqual(
            Schema.decodeUnknownSync(HookNotification)({ workspaceId: "second", cwd: "/repo/é" }),
        );
    });
});

test("serves owner-only sockets and rejects invalid or oversized frames", async () => {
    await withControlServer(async (path, notifications) => {
        if (!isWindows) {
            // A named pipe has no filesystem mode; its DACL is asserted in
            // windows-security.test.ts instead.
            expect((await lstat(path)).mode & 0o777).toBe(CONTROL_SOCKET_MODE);
        }
        expect(await rawRequest(path, ["{invalid}\n"])).toBe(
            '{"ok":false,"error":"invalid_request"}',
        );
        expect(await rawRequest(path, [new Uint8Array([0xff, 0x0a])])).toBe(
            '{"ok":false,"error":"invalid_request"}',
        );
        const validRequest = new TextEncoder().encode(
            `${JSON.stringify({
                type: "notify",
                notification: { workspaceId: "workspace", cwd: "/repo" },
            })}\n`,
        );
        const requestWithBufferedUtf8Suffix = new Uint8Array(validRequest.byteLength + 1);
        requestWithBufferedUtf8Suffix.set(validRequest);
        requestWithBufferedUtf8Suffix[validRequest.byteLength] = 0xf0;
        expect(await rawRequest(path, [requestWithBufferedUtf8Suffix])).toBe(
            '{"ok":false,"error":"invalid_request"}',
        );
        expect(await rawRequest(path, ["x".repeat(CONTROL_SOCKET_MAX_BYTES + 1), "\n"])).toBe(
            '{"ok":false,"error":"payload_too_large"}',
        );
        expect(await rawRequest(path, ["x".repeat(CONTROL_SOCKET_MAX_BYTES), "\n"])).toBe(
            '{"ok":false,"error":"invalid_request"}',
        );
        expect(await rawRequest(path, ["x".repeat(CONTROL_SOCKET_MAX_BYTES), "\r", "\n"])).toBe(
            '{"ok":false,"error":"invalid_request"}',
        );
        expect(
            await rawRequest(path, [
                `${JSON.stringify({
                    type: "notify",
                    notification: { workspaceId: "workspace", cwd: "/repo" },
                })}\n`,
                "extra",
            ]),
        ).toBe('{"ok":false,"error":"invalid_request"}');
        expect(notifications).toEqual([]);
    });
});

test("rejects a synchronously failing notification publisher", async () => {
    const directory = await makeTemporaryDirectory();
    const path = controlPathFor(directory, "publisher-failure");
    const server = await startControlServer({
        path,
        paneId: null,
        notifications: {
            publish() {
                throw new Error("publisher failure");
            },
        },
    });

    try {
        expect(
            await rawRequest(path, [
                JSON.stringify({
                    type: "notify",
                    notification: { workspaceId: "workspace", cwd: "/repo" },
                }),
                "\n",
            ]),
        ).toBe('{"ok":false,"error":"server_failure"}');
    } finally {
        await server.close();
        await rm(directory, { force: true, recursive: true });
    }
});

test("returns server_failure for an asynchronously rejecting notification publisher", async () => {
    const directory = await makeTemporaryDirectory();
    const path = controlPathFor(directory, "publisher-async-failure");
    const server = await startControlServer({
        path,
        paneId: null,
        notifications: {
            async publish() {
                throw new Error("publisher failure");
            },
        },
    });

    try {
        expect(
            await rawRequest(path, [
                JSON.stringify({
                    type: "notify",
                    notification: { workspaceId: "workspace", cwd: "/repo" },
                }),
                "\n",
            ]),
        ).toBe('{"ok":false,"error":"server_failure"}');
    } finally {
        await server.close();
        await rm(directory, { force: true, recursive: true });
    }
});

test("rejects an oversized daemon pane id before binding", async () => {
    const directory = await makeTemporaryDirectory();
    const path = controlPathFor(directory, "invalid-pane");

    try {
        await expect(
            startControlServer({
                path,
                paneId: "x".repeat(4_097),
                notifications: { async publish() {} },
            }),
        ).rejects.toBeInstanceOf(ControlProtocolError);
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});

posixTest("refuses live and unsafe paths while recovering an unbound socket pathname", async () => {
    const directory = await makeTemporaryDirectory();
    const path = `${directory}/control.sock`;
    const live = await startControlServer({
        path,
        paneId: null,
        notifications: { async publish() {} },
    });

    try {
        await expect(prepareControlSocket(path)).rejects.toBeInstanceOf(AlreadyRunning);
    } finally {
        await live.close();
    }

    const liveTarget = `${directory}/live-target.sock`;
    const liveTargetServer = await startControlServer({
        path: liveTarget,
        paneId: null,
        notifications: { async publish() {} },
    });
    await symlink(liveTarget, path);
    try {
        await expect(prepareControlSocket(path)).rejects.toMatchObject({
            _tag: "UnsafeControlSocket",
            reason: "symlink",
        } satisfies Partial<UnsafeControlSocket>);
        await expect(healthControl(path)).rejects.toMatchObject({
            _tag: "UnsafeControlSocket",
            reason: "symlink",
        } satisfies Partial<UnsafeControlSocket>);
    } finally {
        await unlink(path);
        await liveTargetServer.close();
    }

    await writeFile(path, "not a socket");
    await expect(prepareControlSocket(path)).rejects.toMatchObject({
        _tag: "UnsafeControlSocket",
        reason: "not_socket",
    } satisfies Partial<UnsafeControlSocket>);
    await unlink(path);

    const target = `${directory}/target`;
    await writeFile(target, "target");
    await symlink(target, path);
    await expect(prepareControlSocket(path)).rejects.toMatchObject({
        _tag: "UnsafeControlSocket",
        reason: "symlink",
    } satisfies Partial<UnsafeControlSocket>);
    await unlink(path);

    await expect(prepareControlSocket(path)).resolves.toBeUndefined();
    await rm(directory, { force: true, recursive: true });
});

posixTest(
    "atomically removes a current-user orphan socket without touching its pathname race",
    async () => {
        const directory = await makeTemporaryDirectory();
        const path = `${directory}/control.sock`;
        const originalPath = `${directory}/orphan-source.sock`;
        const listener = Bun.listen({
            unix: originalPath,
            socket: {
                data() {},
            },
        });
        await link(originalPath, path);
        listener.stop(true);

        try {
            await prepareControlSocket(path);
            await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    },
);

test("fails closed on an ambiguous liveness probe error", async () => {
    const deniedConnector = {
        connect() {
            return Promise.reject(
                Object.assign(new Error("permission denied"), { code: "EACCES" }),
            );
        },
    };

    await expect(
        probeControlSocket("/tmp/zed-herdr-ambiguous.sock", 150, deniedConnector),
    ).rejects.toMatchObject({
        _tag: "UnsafeControlSocket",
        reason: "probe_failed",
    } satisfies Partial<UnsafeControlSocket>);
});

test("rejects a newline-terminated oversized control response", async () => {
    const directory = await makeTemporaryDirectory();
    const path = controlPathFor(directory, "oversized-response");
    const encodedResponse = new TextEncoder().encode(
        `${"x".repeat(CONTROL_SOCKET_MAX_BYTES + 1)}\n`,
    );
    const responseChunks: Array<Uint8Array> = [];
    for (let offset = 0; offset < encodedResponse.byteLength; offset += 8 * 1024) {
        responseChunks.push(encodedResponse.slice(offset, offset + 8 * 1024));
    }
    const writeResponse = (socket: Bun.Socket<{ offset: number }>): void => {
        while (socket.data.offset < responseChunks.length) {
            const responseChunk = responseChunks[socket.data.offset];
            if (responseChunk === undefined) {
                return;
            }
            const written = socket.write(responseChunk);

            if (written < responseChunk.byteLength) {
                return;
            }
            socket.data.offset += 1;
        }
        socket.end();
    };
    const listener = Bun.listen<{ offset: number }>({
        unix: path,
        socket: {
            open(socket) {
                socket.data = { offset: 0 };
            },
            data(socket) {
                writeResponse(socket);
            },
            drain(socket) {
                writeResponse(socket);
            },
        },
    });

    try {
        await expect(healthControl(path)).rejects.toBeInstanceOf(ControlProtocolError);
    } finally {
        listener.stop(true);
        await rm(directory, { force: true, recursive: true });
    }
});

test("rejects response bytes written after a completed response frame", async () => {
    const directory = await makeTemporaryDirectory();
    const path = controlPathFor(directory, "trailing-response");
    const listener = Bun.listen({
        unix: path,
        allowHalfOpen: true,
        socket: {
            data(socket) {
                socket.write('{"ok":false,"error":"invalid_request"}\n');
                socket.write("extra");
                socket.end();
            },
        },
    });

    try {
        await expect(healthControl(path)).rejects.toBeInstanceOf(ControlProtocolError);
    } finally {
        listener.stop(true);
        await rm(directory, { force: true, recursive: true });
    }
});

test("rejects an incomplete UTF-8 suffix after a completed response frame", async () => {
    const directory = await makeTemporaryDirectory();
    const path = controlPathFor(directory, "buffered-utf8-response");
    const response = new TextEncoder().encode('{"ok":false,"error":"invalid_request"}\n');
    const responseWithBufferedUtf8Suffix = new Uint8Array(response.byteLength + 1);
    responseWithBufferedUtf8Suffix.set(response);
    responseWithBufferedUtf8Suffix[response.byteLength] = 0xf0;
    const listener = Bun.listen({
        unix: path,
        socket: {
            data(socket) {
                socket.end(responseWithBufferedUtf8Suffix);
            },
        },
    });

    try {
        await expect(healthControl(path)).rejects.toMatchObject({
            _tag: "ControlProtocolError",
            detail: "trailing response bytes",
        } satisfies Partial<ControlProtocolError>);
    } finally {
        listener.stop(true);
        await rm(directory, { force: true, recursive: true });
    }
});

test("rejects a notify acknowledgement carrying malformed daemon fields", async () => {
    const directory = await makeTemporaryDirectory();
    const path = controlPathFor(directory, "malformed-notify");
    const listener = Bun.listen({
        unix: path,
        socket: {
            data(socket) {
                socket.end('{"ok":true,"daemon":"spoofed"}\n');
            },
        },
    });
    const notification = Schema.decodeUnknownSync(HookNotification)({
        workspaceId: "workspace",
        cwd: "/repo",
    });

    try {
        await expect(notifyControl(path, notification)).rejects.toBeInstanceOf(
            ControlProtocolError,
        );
    } finally {
        listener.stop(true);
        await rm(directory, { force: true, recursive: true });
    }
});

posixTest("finalization never unlinks a replacement inode", async () => {
    const directory = await makeTemporaryDirectory();
    const path = `${directory}/control.sock`;
    const server = await startControlServer({
        path,
        paneId: null,
        notifications: { async publish() {} },
    });

    await unlink(path);
    await writeFile(path, "replacement");
    await server.close();
    expect(await readFile(path, "utf8")).toBe("replacement");
    await rm(directory, { force: true, recursive: true });
});

posixTest("finalization restores a symlink replacement without dereferencing it", async () => {
    const directory = await makeTemporaryDirectory();
    const path = `${directory}/control.sock`;
    const target = `${directory}/replacement-target`;
    await writeFile(target, "replacement");
    const server = await startControlServer({
        path,
        paneId: null,
        notifications: { async publish() {} },
    });

    await unlink(path);
    await symlink(target, path);
    await server.close();
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readFile(path, "utf8")).toBe("replacement");
    await rm(directory, { force: true, recursive: true });
});

/** The request-side view of a daemon: exactly the fields a stop may name. */
const stopTarget = (daemon: {
    readonly identity: string;
    readonly pid: number;
    readonly startedAt: string;
}) => ({ identity: daemon.identity, pid: daemon.pid, startedAt: daemon.startedAt });

const endpointClosed = async (path: string): Promise<boolean> => {
    if (await probeControlSocket(path)) {
        return false;
    }
    if (isWindows) {
        return true;
    }
    try {
        await lstat(path);
        return false;
    } catch {
        return true;
    }
};

test("answers a matching stop with one exact acknowledgement before requesting shutdown", async () => {
    const directory = await makeTemporaryDirectory();
    const path = controlPathFor(directory, "stop-ack");
    let stops = 0;
    const server = await startControlServer({
        path,
        paneId: "daemon-pane",
        notifications: { async publish() {} },
        stopRequested() {
            stops += 1;
        },
    });

    try {
        const request = JSON.stringify({ type: "stop", daemon: stopTarget(server.daemon) });
        const acknowledgement = JSON.stringify({
            ok: true,
            stopping: true,
            daemon: server.daemon,
        });

        // The acknowledgement is never truncated: the client always reads the whole
        // frame even though the handler tears the daemon down immediately after it.
        expect(await rawRequest(path, [`${request}\n`])).toBe(acknowledgement);
        for (let attempt = 0; attempt < 100 && stops === 0; attempt += 1) {
            await Bun.sleep(5);
        }
        expect(stops).toBe(1);

        // A retried request is still answered, but the shutdown request is a latch.
        expect(await rawRequest(path, [`${request}\n`])).toBe(acknowledgement);
        await Bun.sleep(25);
        expect(stops).toBe(1);
    } finally {
        await server.close();
        await rm(directory, { force: true, recursive: true });
    }
});

test("refuses a stop aimed at another daemon instance", async () => {
    const directory = await makeTemporaryDirectory();
    const path = controlPathFor(directory, "stop-foreign");
    let stops = 0;
    const server = await startControlServer({
        path,
        paneId: null,
        notifications: { async publish() {} },
        stopRequested() {
            stops += 1;
        },
    });

    try {
        const current = server.daemon;
        const staleRequests = [
            { ...stopTarget(current), pid: current.pid + 1 },
            { ...stopTarget(current), startedAt: "1999-01-01T00:00:00.000Z" },
            { ...stopTarget(current), identity: "artisann.zed-herdr:other" },
            { identity: current.identity, pid: current.pid },
        ];

        for (const daemon of staleRequests) {
            expect(await rawRequest(path, [`${JSON.stringify({ type: "stop", daemon })}\n`])).toBe(
                '{"ok":false,"error":"invalid_request"}',
            );
        }
        await Bun.sleep(25);
        expect(stops).toBe(0);
        // The live daemon keeps serving after a refused stop.
        expect(await healthControl(path)).toEqual(current);
    } finally {
        await server.close();
        await rm(directory, { force: true, recursive: true });
    }
});

test("fails closed when the server registered no stop handler", async () => {
    const directory = await makeTemporaryDirectory();
    const path = controlPathFor(directory, "stop-unsupported");
    const server = await startControlServer({
        path,
        paneId: null,
        notifications: { async publish() {} },
    });

    try {
        const request = JSON.stringify({ type: "stop", daemon: stopTarget(server.daemon) });
        expect(await rawRequest(path, [`${request}\n`])).toBe(
            '{"ok":false,"error":"server_failure"}',
        );
        expect(await healthControl(path)).toEqual(server.daemon);
    } finally {
        await server.close();
        await rm(directory, { force: true, recursive: true });
    }
});

test("stopControl waits for the endpoint to close and never signals a process", async () => {
    const directory = await makeTemporaryDirectory();
    const path = controlPathFor(directory, "stop-client");
    const originalKill = process.kill;
    let signals = 0;
    process.kill = ((pid: number, signal?: string | number) => {
        signals += 1;
        return originalKill.call(process, pid, signal as NodeJS.Signals);
    }) as typeof process.kill;
    let server: Awaited<ReturnType<typeof startControlServer>> | undefined;

    try {
        const started = await startControlServer({
            path,
            paneId: null,
            notifications: { async publish() {} },
            stopRequested() {
                void server?.close();
            },
        });
        server = started;

        expect(await stopControl(path)).toEqual(started.daemon);
        expect(await endpointClosed(path)).toBe(true);
        expect(signals).toBe(0);
    } finally {
        process.kill = originalKill;
        await server?.close();
        await rm(directory, { force: true, recursive: true });
    }
});

test("stopControl reports an absent daemon without creating an endpoint", async () => {
    const directory = await makeTemporaryDirectory();
    const path = controlPathFor(directory, "stop-absent");

    try {
        await expect(stopControl(path)).rejects.toBeInstanceOf(ControlUnavailable);
        expect(await probeControlSocket(path)).toBe(false);
        if (!isWindows) {
            await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
        }
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});

test("health refuses a stop acknowledgement", async () => {
    const directory = await makeTemporaryDirectory();
    const path = controlPathFor(directory, "health-vs-stop");
    const listener = Bun.listen({
        unix: path,
        socket: {
            data(socket) {
                socket.end(
                    `${JSON.stringify({
                        ok: true,
                        stopping: true,
                        daemon: {
                            identity: "artisann.zed-herdr:daemon",
                            paneId: null,
                            pid: 41,
                            startedAt: "2026-01-01T00:00:00.000Z",
                            protocol: 22,
                            beyondTested: false,
                        },
                    })}\n`,
                );
            },
        },
    });

    try {
        await expect(healthControl(path)).rejects.toBeInstanceOf(ControlProtocolError);
    } finally {
        listener.stop(true);
        await rm(directory, { force: true, recursive: true });
    }
});

test("stopControl refuses a health acknowledgement", async () => {
    const directory = await makeTemporaryDirectory();
    const path = controlPathFor(directory, "stop-vs-health");
    const listener = Bun.listen({
        unix: path,
        socket: {
            data(socket) {
                socket.end(
                    `${JSON.stringify({
                        ok: true,
                        daemon: {
                            identity: "artisann.zed-herdr:daemon",
                            paneId: null,
                            pid: 41,
                            startedAt: "2026-01-01T00:00:00.000Z",
                            protocol: 22,
                            beyondTested: false,
                        },
                    })}\n`,
                );
            },
        },
    });

    try {
        await expect(stopControl(path)).rejects.toBeInstanceOf(ControlProtocolError);
    } finally {
        listener.stop(true);
        await rm(directory, { force: true, recursive: true });
    }
});

test("refuses a stop acknowledgement that names another daemon instance", async () => {
    const directory = await makeTemporaryDirectory();
    const path = controlPathFor(directory, "stop-wrong-instance");
    const target = {
        identity: "artisann.zed-herdr:daemon",
        paneId: null,
        pid: 41,
        startedAt: "2026-01-01T00:00:00.000Z",
        protocol: 22,
        beyondTested: false,
    };
    let stops = 0;
    const listener = Bun.listen({
        unix: path,
        socket: {
            data(socket, chunk) {
                const request = JSON.parse(new TextDecoder().decode(chunk).trim()) as {
                    type: string;
                };
                if (request.type === "health") {
                    socket.end(`${JSON.stringify({ ok: true, daemon: target })}\n`);
                    return;
                }
                stops += 1;
                // A different instance answers the stop: the caller never
                // observed this daemon, so the reply must not count as success.
                socket.end(
                    `${JSON.stringify({
                        ok: true,
                        stopping: true,
                        daemon: { ...target, pid: target.pid + 1 },
                    })}\n`,
                );
            },
        },
    });

    try {
        await expect(stopControl(path, 2_000)).rejects.toBeInstanceOf(ControlProtocolError);
        expect(stops).toBe(1);
        expect(await probeControlSocket(path)).toBe(true);
    } finally {
        listener.stop(true);
        await rm(directory, { force: true, recursive: true });
    }
});

test("never reports a stop as complete while the endpoint is still there", async () => {
    const directory = await makeTemporaryDirectory();
    const path = controlPathFor(directory, "stop-not-closed");
    // The daemon acknowledges but never finishes its cleanup: an acknowledgement
    // is not completion, so the command must fail instead of claiming success.
    const server = await startControlServer({
        path,
        paneId: null,
        notifications: { async publish() {} },
        stopRequested() {},
    });

    try {
        await expect(stopControl(path, 250)).rejects.toBeInstanceOf(ControlUnavailable);
        expect(await healthControl(path)).toEqual(server.daemon);
    } finally {
        await server.close();
        await rm(directory, { force: true, recursive: true });
    }
});

test("includes occupied-pipe prechecks in the stop deadline and never writes after expiry", async () => {
    const child = Bun.spawn({
        cmd: [
            process.execPath,
            "-e",
            `
import { expect, mock, spyOn } from "bun:test";
const pipeModule = ${JSON.stringify(new URL("../../src/plugin/windows-pipe.ts", import.meta.url).href)};
const controlModule = ${JSON.stringify(new URL("../../src/plugin/control.ts", import.meta.url).href)};
const pipe = await import(pipeModule);
let now = 0;
let connections = 0;
const writes = [];
const retries = [];
const daemon = {
    identity: "artisann.zed-herdr:daemon",
    pid: 123,
    startedAt: "2026-10-31T00:00:00.000Z",
    paneId: null,
    protocol: 22,
    beyondTested: false,
};
mock.module(pipeModule, () => ({
    ...pipe,
    isWindowsControlPlatform: () => true,
    windowsPipePresence: async () => writes.includes("stop")
        ? "absent" : connections === 0 ? "present" : "occupied",
    windowsPipeOwner: () => "own",
    waitForWindowsPipeReady: async (_path, milliseconds) => {
        retries.push(milliseconds);
        now += milliseconds;
        return true;
    },
}));
spyOn(Date, "now").mockImplementation(() => now);
spyOn(Bun, "connect").mockImplementation(async (options) => {
    connections += 1;
    const client = {
        terminate() {},
        write(frame) {
            const request = JSON.parse(frame);
            writes.push(request.type);
            queueMicrotask(() => {
                if (request.type === "health") now = 4950;
                const response = request.type === "health"
                    ? { ok: true, daemon }
                    : { ok: true, stopping: true, daemon };
                options.socket.data(client, Buffer.from(JSON.stringify(response) + "\\n"));
                options.socket.end(client);
            });
        },
    };
    return client;
});
const { stopControl } = await import(controlModule);
await expect(stopControl("deadline-test", 5000)).rejects.toMatchObject({
    operation: "timeout",
});
expect(now).toBe(5000);
expect(retries).toEqual([50]);
expect(connections).toBe(1);
expect(writes).toEqual(["health"]);
`,
        ],
        stdout: "pipe",
        stderr: "pipe",
    });
    try {
        const [exitCode, stderr] = await Promise.all([
            child.exited,
            new Response(child.stderr).text(),
        ]);
        expect(stderr).toBe("");
        expect(exitCode).toBe(0);
    } finally {
        child.kill();
        await child.exited;
    }
});

posixTest("treats an endpoint it cannot inspect as unproven, not as stopped", async () => {
    const directory = await makeTemporaryDirectory();
    const path = `${directory}/control.sock`;
    const server = await startControlServer({
        path,
        paneId: null,
        notifications: { async publish() {} },
        stopRequested() {},
    });

    try {
        await chmod(directory, 0o000);
        // EACCES on the containing directory proves nothing about the daemon: the
        // command must refuse instead of reporting the endpoint as gone. Root (and
        // any host that still allows the lookup) cannot exercise this path.
        const denied = await lstat(path).then(
            () => false,
            () => true,
        );
        if (denied) {
            await expect(stopControl(path, 200)).rejects.toBeInstanceOf(UnsafeControlSocket);
        }
    } finally {
        await chmod(directory, 0o700);
        await server.close();
        await rm(directory, { force: true, recursive: true });
    }
});
