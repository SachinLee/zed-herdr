import * as BunContext from "@effect/platform-bun/BunContext";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Runtime from "effect/Runtime";
import * as Stream from "effect/Stream";
import type { AppConfig } from "./config.ts";
import type { WorkspaceCwdHint } from "./domain/workspace.ts";
import { makeZedEditorAdapterLayer } from "./editor/zed.ts";
import { HerdRClient, HerdRClientLive } from "./herdr/client.ts";
import { HerdRWorkspaceSourceLive } from "./herdr/workspace-source.ts";
import { controlSocketPath, startControlServer } from "./plugin/control.ts";
import { BACKGROUND_DAEMON_MARKER } from "./plugin/daemon-process.ts";
import { daemonLogLoggerLayer, daemonLogPath, openDaemonLog } from "./plugin/daemon-log.ts";
import type { DaemonHealth, HookNotification } from "./plugin/protocol.ts";
import { WorkspaceHintSource } from "./services/workspace-hint-source.ts";
import { makeSyncDaemonWithProjectMode } from "./sync/daemon.ts";

const CONTROL_NOTIFICATION_QUEUE_CAPACITY = 256;

/**
 * The live synchronization core, published after the control endpoint is bound.
 * Before that point health reports "no negotiated protocol", exactly like a
 * client that has not received a snapshot yet.
 */
interface DaemonControls {
    readonly protocolStatus: () => Pick<DaemonHealth, "protocol" | "beyondTested">;
    readonly toggleEnabled: Effect.Effect<boolean>;
}

const makeWorkspaceHintSourceLive = (hints: Stream.Stream<WorkspaceCwdHint>) =>
    Layer.succeed(WorkspaceHintSource, { hints });

const JsonLoggerLive = Logger.json;
const sourceWithLogger = (logger: Layer.Layer<never>) => {
    const HerdRClientLiveWithLogger = HerdRClientLive.pipe(Layer.provide(logger));
    return HerdRWorkspaceSourceLive.pipe(Layer.provideMerge(HerdRClientLiveWithLogger));
};

export const makeAppLayer = (
    config: AppConfig,
    hints: Stream.Stream<WorkspaceCwdHint> = Stream.empty,
    logger: Layer.Layer<never> = JsonLoggerLive,
) =>
    Layer.mergeAll(
        BunContext.layer,
        sourceWithLogger(logger),
        makeZedEditorAdapterLayer({ executable: config.zedBin }).pipe(
            Layer.provide(BunContext.layer),
        ),
        makeWorkspaceHintSourceLive(hints),
    ).pipe(Layer.provideMerge(logger));

const runDaemonCore = (
    config: AppConfig,
    environment: NodeJS.ProcessEnv,
    logger: Layer.Layer<never>,
) =>
    Effect.scoped(
        Effect.gen(function* () {
            const notifications = yield* Queue.bounded<HookNotification>(
                CONTROL_NOTIFICATION_QUEUE_CAPACITY,
            );
            yield* Effect.addFinalizer(() => Queue.shutdown(notifications));
            const stopSignal = yield* Deferred.make<void>();
            // Unsafe because the control callbacks read it synchronously; the
            // value is written once, before any request can observe it.
            const controls = Ref.unsafeMake<DaemonControls | null>(null);
            const runtime = yield* Effect.runtime<never>();
            const paneId = environment.HERDR_PANE_ID?.trim() || null;

            // Bound first so it is released last: the endpoint keeps answering
            // (and can still acknowledge a stop) while the synchronization core
            // and HerdR source unwind, and only then disappears.
            yield* Effect.acquireRelease(
                Effect.tryPromise({
                    try: () =>
                        startControlServer({
                            path: controlSocketPath(environment),
                            paneId,
                            notifications: {
                                publish: (notification) =>
                                    Runtime.runPromise(runtime)(
                                        Queue.offer(notifications, notification).pipe(
                                            Effect.asVoid,
                                        ),
                                    ),
                            },
                            toggleEnabled: async () => {
                                const current = await Runtime.runPromise(runtime)(
                                    Ref.get(controls),
                                );
                                if (current === null) {
                                    throw new Error("zed-herdr daemon controls are not ready");
                                }
                                return Runtime.runPromise(runtime)(current.toggleEnabled);
                            },
                            protocolStatus: () => {
                                const current = Effect.runSync(Ref.get(controls));
                                return current === null
                                    ? { protocol: null, beyondTested: false }
                                    : current.protocolStatus();
                            },
                            stopRequested: () => {
                                Runtime.runFork(runtime)(
                                    Deferred.succeed(stopSignal, undefined).pipe(Effect.asVoid),
                                );
                            },
                        }),
                    catch: (cause) => cause,
                }),
                (server) =>
                    Effect.promise(() => server.close()).pipe(Effect.catchAllCause(Effect.die)),
            );

            return yield* Effect.scoped(
                Effect.gen(function* () {
                    const daemon = yield* makeSyncDaemonWithProjectMode(config.projectMode);
                    const herdr = yield* HerdRClient;
                    yield* Ref.set(controls, {
                        protocolStatus: herdr.protocolStatus,
                        toggleEnabled: daemon.toggleEnabled,
                    });
                    yield* Effect.race(daemon.run, Deferred.await(stopSignal));
                }).pipe(
                    Effect.provide(makeAppLayer(config, Stream.fromQueue(notifications), logger)),
                ),
            );
        }),
    ).pipe(Effect.provide(logger));

export const runDaemon = (config: AppConfig, environment: NodeJS.ProcessEnv = process.env) => {
    if (environment[BACKGROUND_DAEMON_MARKER] !== "1") {
        return runDaemonCore(config, environment, JsonLoggerLive);
    }
    return Effect.scoped(
        Effect.gen(function* () {
            const failure = yield* Deferred.make<never, unknown>();
            const runtime = yield* Effect.runtime<never>();
            const log = yield* Effect.acquireRelease(
                Effect.tryPromise({
                    try: () =>
                        openDaemonLog(
                            daemonLogPath(controlSocketPath(environment), environment),
                            (error) => {
                                Runtime.runFork(runtime)(Deferred.fail(failure, error));
                            },
                        ),
                    catch: (error) => error,
                }),
                (handle) => Effect.promise(() => handle.close()),
            );
            yield* Effect.try({
                try: () => log.writeRecord({ type: "daemon_started", pid: process.pid }),
                catch: (error) => error,
            });
            return yield* Effect.raceFirst(
                runDaemonCore(config, environment, daemonLogLoggerLayer(log)),
                Deferred.await(failure),
            );
        }),
    );
};
