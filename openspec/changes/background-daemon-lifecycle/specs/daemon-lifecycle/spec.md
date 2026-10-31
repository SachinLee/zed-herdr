# Spec Delta

## Purpose

Defines how the workspace-sync daemon starts, stays unique, reports readiness, stops under
owner-validated control, and survives plugin updates while running detached from any HerdR pane.

## ADDED Requirements

### Requirement: Hooks start one detached hidden daemon

The plugin hooks SHALL ensure exactly one synchronization daemon is running for the session by
starting it as a detached background process that owns no HerdR pane. Concurrent hooks MUST NOT
start a second daemon.

#### Scenario: First hook starts the daemon

- **WHEN** a `workspace.created` or `workspace.focused` hook runs and no live matching daemon answers on the session control socket
- **THEN** exactly one daemon process is started detached from the hook, no HerdR pane is opened for it, and the hook publishes its cwd hint before exiting with status 0

#### Scenario: Concurrent hooks converge

- **WHEN** two hooks run for the same session while no daemon is live
- **THEN** only one daemon process exists afterwards and both hooks publish their hints

#### Scenario: Live daemon is reused

- **WHEN** a hook runs while a live matching daemon owns the control socket
- **THEN** the hook publishes its cwd hint and starts no additional process

### Requirement: Background daemon inherits the invoking session configuration

The detached daemon SHALL receive the invoking session's configuration, so it serves the same HerdR
session and control socket as the hook that started it.

#### Scenario: Session environment is preserved

- **WHEN** a hook starts the daemon with `HERDR_SOCKET_PATH`, `HERDR_SESSION`, `XDG_CONFIG_HOME`, `ZED_BIN`, or `ZED_HERDR_PROJECT_MODE` set
- **THEN** `health` against that same session path answers for the started daemon, and the daemon applies the same project mode and editor binary

#### Scenario: Pane identity is not fabricated

- **WHEN** the daemon is started by a hook or by `start` outside a HerdR pane
- **THEN** it reports no pane identity rather than inheriting an unrelated `HERDR_PANE_ID`

### Requirement: Hook startup is bounded by a readiness deadline

Hook startup SHALL wait for control readiness no longer than the configured readiness deadline.

#### Scenario: Daemon never becomes ready

- **WHEN** the started daemon does not answer on the control socket before the readiness deadline
- **THEN** the hook fails with a bounded readiness message, exits non-zero, publishes no cwd hint, and leaves no lock that blocks a later hook

#### Scenario: Daemon becomes ready in time

- **WHEN** the started daemon answers before the readiness deadline
- **THEN** the hook publishes its cwd hint and exits with status 0

### Requirement: Explicit start is idempotent

The `start` command SHALL start the detached daemon when none is live and SHALL NOT start a second
daemon when one already answers.

#### Scenario: Start with no daemon

- **WHEN** an operator runs the `start` command and no daemon answers on the session control socket
- **THEN** one detached daemon starts, `start` reports success, and a following `health` succeeds

#### Scenario: Start with a live daemon

- **WHEN** an operator runs the `start` command while a live matching daemon answers
- **THEN** the command reports the daemon as already running, exits with status 0, and the daemon pid and start time are unchanged

### Requirement: Stop shuts down through owner-validated control

The `stop` command SHALL stop the daemon only by asking the owner-validated local control socket,
and the daemon SHALL perform graceful scoped cleanup before exiting.

#### Scenario: Graceful stop

- **WHEN** an operator runs `stop` and a live, owner-validated matching daemon answers
- **THEN** the daemon closes its control socket and HerdR subscription, releases the session lock, exits successfully within the stop deadline, and `stop` reports success

#### Scenario: Foreign or unverifiable owner

- **WHEN** the control socket is owned by another user, reports a different daemon identity, or cannot be validated as the plugin's own socket
- **THEN** `stop` refuses with a non-zero exit and bounded message, and leaves the socket and any process untouched

#### Scenario: Stop never signals arbitrary processes

- **WHEN** `stop` runs
- **THEN** it does not read a pid from state files or signal a pid it did not validate through the control socket

#### Scenario: Stop with no daemon

- **WHEN** `stop` runs and no daemon answers
- **THEN** the command exits non-zero reporting that no daemon is running, and no daemon is started as a side effect

### Requirement: Health reports background daemons

`health` SHALL report a detached daemon without requiring a HerdR pane, and SHALL NOT start a daemon.

#### Scenario: Background daemon health

- **WHEN** the daemon was started detached and answers `health`
- **THEN** the response is `ok: true` with `paneId: null` plus the daemon identity, pid, start time, and protocol status

#### Scenario: Health starts nothing

- **WHEN** `health` runs and no daemon answers
- **THEN** the command exits with status 1 and no daemon process is started

### Requirement: Plugin update keeps exactly one current daemon

The operator procedure SHALL stop the running daemon before rebuilding the plugin and start a
single fresh daemon afterwards, in the documented order: disable, stop, build, enable, start.

#### Scenario: Documented update order

- **WHEN** the README update procedure is followed in order
- **THEN** the daemon is stopped before the build writes `dist/index.js`, and the final `start` produces a daemon whose start time is later than the build

#### Scenario: Update leaves one daemon

- **WHEN** an update completes
- **THEN** exactly one daemon answers `health` and no daemon started from the previous build remains

### Requirement: Detached daemon logging is bounded on disk

A detached daemon has no terminal, so its diagnostics SHALL go to a bounded destination whose disk
usage does not grow without limit.

#### Scenario: Long-running daemon

- **WHEN** a background daemon produces diagnostics over a long period
- **THEN** its log destination is rotated or truncated at a documented size and retention limit

#### Scenario: Log destination unavailable

- **WHEN** the log destination cannot be written at startup
- **THEN** the daemon reports a bounded failure instead of silently discarding diagnostics, and the hook or `start` reports the failure

### Requirement: POSIX detached startup is preserved

On macOS and Linux the plugin SHALL start the daemon only through a detached-spawn mechanism
supported by the Bun runtime, preserving the existing owner-only socket, lock, and stop semantics.

#### Scenario: POSIX background start

- **WHEN** a hook or `start` runs on macOS or Linux
- **THEN** the daemon survives the hook process exiting, is reachable on the session control socket, and is stopped only through the control socket

#### Scenario: No platform-specific shortcut

- **WHEN** the detached start or stop path is exercised on a POSIX host
- **THEN** it requires no Windows-only API, no shell invocation, and no additional runtime dependency
