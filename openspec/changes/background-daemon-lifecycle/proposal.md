# 提案：后台运行与停止管理

## Why

Today the plugin's only daemon entry point is a HerdR plugin pane: the activation hook opens a
visible `daemon` tab, and the daemon lives and dies with that terminal. Headless setups therefore
have no daemon at all, every workspace pays for a tab it does not want, and the only way to stop a
stale daemon is to kill a pane or a pid. Zed workspace sync needs a daemon that the plugin owns, not
a terminal that a user must keep open.

## What Changes

- Plugin hooks start **one detached, hidden daemon** instead of opening a HerdR pane. Concurrent
  hooks still converge on a single instance through the existing per-session lock, the spawned
  daemon inherits the invoking session's configuration, and the hook waits for a bounded readiness
  deadline before publishing its cwd hint.
- New `start` command that starts the same detached daemon explicitly and is idempotent: a live
  matching daemon is reported as already running instead of spawning a second one.
- New `stop` command that shuts the daemon down through the owner-validated control socket with
  graceful scoped cleanup (control socket, HerdR subscription, child processes). `stop` never
  signals an arbitrary pid and never starts a daemon.
- `health` keeps its current contract for background daemons: a daemon with no HerdR pane reports
  `paneId: null`, and `health` still never starts anything.
- **BREAKING**: the mandatory `daemon` plugin pane goes away, so pane-based inspection is replaced
  by `health` plus a bounded log destination.
- A documented plugin update sequence — disable, stop, build, enable, start — so a rebuilt bundle
  never has to fight a daemon still running the old one.
- Daemon output is bounded on disk; a detached daemon must not accumulate an unbounded log file.

## Capabilities

### New Capabilities

- `daemon-lifecycle`: background daemon start, readiness, idempotent re-start, owner-validated
  graceful stop, pane-free health reporting, bounded log destination, and the update ordering that
  keeps exactly one daemon running a current build.

### Modified Capabilities

None. The project has no published capability specs yet, so this change establishes the lifecycle
capability as a whole.

## Impact

- `src/plugin/hook.ts`: pane-open startup becomes detached background start behind the same lock
  and readiness deadline.
- `src/cli.ts`: `start` and `stop` join `daemon`, `hook`, `health`, and `toggle` in the exact
  command set and exit codes.
- `src/plugin/control.ts` and `src/plugin/protocol.ts`: the control protocol gains a stop request
  answered only by the owner-validated daemon.
- `src/app.ts`: daemon shutdown must remain scoped so a stop request completes cleanup before exit.
- `herdr-plugin.toml`: the `daemon` pane declaration and hook wiring change; hooks no longer open a
  pane.
- `README.md`: operator runbook for background start, stop, health, log inspection, and update
  ordering replaces the pane-inspection steps.
- `test/plugin/` and `test/e2e/`: single-instance, readiness deadline, idempotent start, stop
  ownership, negative pid-kill, no-start-from-stop, and `paneId: null` health contracts, plus a
  POSIX parity check for the detached spawn.
