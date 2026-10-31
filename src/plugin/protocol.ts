import * as Schema from "effect/Schema";

import { WorkspaceCwdHint } from "../domain/workspace.ts";

const ControlText = Schema.String.pipe(Schema.nonEmptyString(), Schema.maxLength(4_096));
const IsoTimestamp = Schema.String.pipe(Schema.nonEmptyString(), Schema.maxLength(64));
const ProcessId = Schema.Number.pipe(Schema.int(), Schema.nonNegative());
const ProtocolVersion = Schema.Number.pipe(Schema.int(), Schema.nonNegative());

/** A workspace directory hint emitted by the lightweight HerdR plugin hook. */
export const HookNotification = WorkspaceCwdHint;
export type HookNotification = Schema.Schema.Type<typeof HookNotification>;

/** Tolerant inbound control request schemas. Unknown properties are discarded. */
export const NotifyControlRequest = Schema.Struct({
    type: Schema.Literal("notify"),
    notification: HookNotification,
});
export type NotifyControlRequest = Schema.Schema.Type<typeof NotifyControlRequest>;

export const HealthControlRequest = Schema.Struct({
    type: Schema.Literal("health"),
});
export type HealthControlRequest = Schema.Schema.Type<typeof HealthControlRequest>;

export const ToggleControlRequest = Schema.Struct({
    type: Schema.Literal("toggle"),
});
export type ToggleControlRequest = Schema.Schema.Type<typeof ToggleControlRequest>;

export const DaemonIdentity = Schema.Literal("artisann.zed-herdr:daemon");
export type DaemonIdentity = Schema.Schema.Type<typeof DaemonIdentity>;

/**
 * A stop names the exact daemon instance it means. The three identity fields are
 * the ones a health call can observe; a request that does not match the live
 * process is refused instead of stopping a daemon the caller never saw.
 */
export const StopControlRequest = Schema.Struct({
    type: Schema.Literal("stop"),
    daemon: Schema.Struct({
        identity: DaemonIdentity,
        pid: ProcessId,
        startedAt: IsoTimestamp,
    }),
});
export type StopControlRequest = Schema.Schema.Type<typeof StopControlRequest>;

export const ControlRequest = Schema.Union(
    NotifyControlRequest,
    HealthControlRequest,
    ToggleControlRequest,
    StopControlRequest,
);
export type ControlRequest = Schema.Schema.Type<typeof ControlRequest>;

/** The daemon-owned fields reported to a local health client. */
export const DaemonHealth = Schema.Struct({
    identity: DaemonIdentity,
    paneId: Schema.NullOr(ControlText),
    pid: ProcessId,
    startedAt: IsoTimestamp,
    protocol: Schema.NullOr(ProtocolVersion),
    beyondTested: Schema.Boolean,
});
export type DaemonHealth = Schema.Schema.Type<typeof DaemonHealth>;

/** Exact success wire responses. */
export const NotifyControlResponse = Schema.Struct({
    ok: Schema.Literal(true),
});
export type NotifyControlResponse = Schema.Schema.Type<typeof NotifyControlResponse>;

export const HealthControlResponse = Schema.Struct({
    ok: Schema.Literal(true),
    daemon: DaemonHealth,
});
export type HealthControlResponse = Schema.Schema.Type<typeof HealthControlResponse>;

export const ToggleControlResponse = Schema.Struct({
    ok: Schema.Literal(true),
    enabled: Schema.Boolean,
});
export type ToggleControlResponse = Schema.Schema.Type<typeof ToggleControlResponse>;

/**
 * A stop acknowledgement is distinct from a health report on the wire: the
 * `stopping` marker makes the two shapes mutually exclusive so a client can
 * never accept one while waiting for the other.
 */
export const StopControlResponse = Schema.Struct({
    ok: Schema.Literal(true),
    stopping: Schema.Literal(true),
    daemon: DaemonHealth,
});
export type StopControlResponse = Schema.Schema.Type<typeof StopControlResponse>;

/** Exact failure wire response: client input failures or server publish failure. */
export const ControlFailureResponse = Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Literal("invalid_request", "payload_too_large", "server_failure"),
});
export type ControlFailureResponse = Schema.Schema.Type<typeof ControlFailureResponse>;

export const ControlResponse = Schema.Union(
    // The stop acknowledgement must be tried first: it is the only success shape
    // carrying `stopping`, and a tolerant struct would otherwise strip it into a
    // plain health report.
    StopControlResponse,
    HealthControlResponse,
    ToggleControlResponse,
    NotifyControlResponse,
    ControlFailureResponse,
);
export type ControlResponse = Schema.Schema.Type<typeof ControlResponse>;
