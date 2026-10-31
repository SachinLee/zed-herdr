# T1 (Slice 1 / `stop`) — implementation evidence

Platform: Windows (win32), Bun 1.4.4. POSIX-only tests report `skip` here; they are **NOT RUN** on
macOS/Linux in this session.

## Files changed

- `src/plugin/protocol.ts` — added `StopControlRequest` (`{type:"stop", daemon:{identity,pid,startedAt}}`),
  `StopControlResponse` (`{ok:true, stopping:true, daemon}`) and joined them to `ControlRequest` /
  `ControlResponse`. The stop success shape is tried **first** in the response union so a tolerant
  struct cannot strip `stopping` and silently read the acknowledgement as a health report.
- `src/plugin/control.ts` — `StartControlServerOptions.stopRequested?: () => void`; stop dispatch in
  `responseFor` with an instance comparison (`identity`, `pid`, `startedAt`) against the live daemon
  before any side effect; `isExactControlResponse` extended with the exact `["ok","stopping","daemon"]`
  shape; per-command success validation in `requestControl(..., expected)` so `health`/`stop`/`toggle`/
  `notify` each refuse another command's success frame; `stopControl()` (health → conditional stop →
  wait for the endpoint to disappear, `STOP_CONTROL_TIMEOUT_MS = 5_000`, `STOP_CLOSE_POLL_MS = 25`);
  one-shot stop latch per bound endpoint.
- `src/app.ts` — control endpoint is now the **outer** scope and the sync daemon / HerdR source the
  inner scope, so the inner finalizers (subscription, fibers, caches) run first and the endpoint closes
  last. `daemon.run` races `Deferred.await(stopSignal)`; no `process.exit`, no signals.
- `src/cli.ts` — `stop` command dispatch, usage string, `{ok:true,daemon}` output, identity check,
  existing bounded 4,096-character failure rendering and exit code 1.
- Tests: `test/plugin/control-socket.test.ts`, `test/plugin/control.test.ts`,
  `test/plugin/windows-control.test.ts`, `test/e2e/daemon.test.ts` (stop scenarios).

## ACK-before-shutdown mechanism (design D4 "ACK 不是完成")

The previous draft signalled shutdown from a `setImmediate` macrotask, which is a *guessed* flush.
It was replaced with an observed-completion write, using the documented Bun semantics in
`node_modules/bun-types/bun.d.ts`:

- `write(data, byteOffset?, byteLength?): number` (line 5782) — unbuffered, returns the number of bytes
  accepted by the transport, `-1` when closed/shutting down.
- `end(data?): number` (line 5818) — returns the number of bytes written for the final chunk.
- `drain` (socket handler) — documented flush completion for buffered bytes (line 5893-5901).

`responseFor` therefore encodes the acknowledgement once, `socket.write`s it, and:

- fewer than 0 bytes / throw → the peer vanished: terminate, **do not** request shutdown;
- a partial write → the remainder is kept in `ConnectionState.pendingStop` and completed from `drain`;
  shutdown is requested only once the last byte is accepted;
- a full write → `socket.end()` then `requestStop()`.

No timers, no arbitrary macrotask, no `process.kill`. The client deadline (5 000 ms) bounds the whole
interaction and is the only time source.

## RED (before implementation)

`bun test test/plugin/control-socket.test.ts test/plugin/windows-control.test.ts`:

- `test/plugin/control-socket.test.ts` — suite failed to load: `stopControl` was not exported yet
  (1 error), so every stop assertion in that file could not run.
- `test/plugin/windows-control.test.ts:309` — `expect(response).toBe(<stop ACK>)` received
  `{"ok":false,"error":"invalid_request"}` (3 failing assertions): the stop request did not decode,
  because neither the request schema nor the dispatch existed.

No implementation was adjusted to make these pass other than adding the missing request/response,
dispatch, client helper, and scope ordering.

## GREEN (after implementation)

```
bun run build
  Bundled 554 modules  → dist/index.js 0.80 MB

bun test test/plugin/control-socket.test.ts test/plugin/control.test.ts \
         test/plugin/windows-control.test.ts test/plugin/windows-security.test.ts \
         test/e2e/daemon.test.ts
  48 pass
  9 skip      (posix-only cases on this Windows host — NOT RUN for macOS/Linux)
  0 fail
  206 expect() calls
  Ran 57 tests across 5 files
  EXIT=0

bun run typecheck   → exit 0
bun run lint        → exit 0
```

Individual suites: `control-socket` 20 pass / 9 skip / 0 fail; `control` + `windows-control` +
`windows-security` 23 pass / 0 fail (`EXIT=0`); `e2e/daemon` 5 pass / 0 fail.

### Runner exit-code pin (fixed in the reconciliation pass)

The earlier run of this same command ended `EXIT=1` while every test passed: any test that sets
`process.exitCode = 1` pins Bun's runner exit code even after the value is restored (reproduced with a
throwaway probe: one passing test that sets and restores `process.exitCode` → `1 pass, 0 fail, EXIT=1`).
The trigger was the absent-daemon `stop` assertion going through the in-process `runControlCli` helper.
That assertion now runs in a subprocess (`runIsolatedControlCli`), so the combined command exits 0;
no exit-code artifact is claimed as a pass.

## What the green tests prove

- A matching stop is answered with exactly one `{ok:true,stopping:true,daemon}` frame, the whole frame is
  delivered before the injected shutdown callback runs, and a retried stop is still answered while the
  callback stays a latch (`stops === 1`).
- A stop naming another `pid`, `startedAt`, `identity`, or a truncated target is refused with
  `{"ok":false,"error":"invalid_request"}`, the callback never runs, and the daemon keeps serving health.
- A server without a stop handler answers `{"ok":false,"error":"server_failure"}`.
- `healthControl` rejects a stop acknowledgement and `stopControl` rejects a health acknowledgement
  (`ControlProtocolError`), so no command can accept another command's success shape.
- `stopControl` returns the acknowledged daemon only after the endpoint is observed gone, and reports
  `ControlUnavailable` when nothing answers without creating an endpoint.
- E2E against the built `dist/index.js`: `stop` exits 0 with empty stderr, the daemon exits 0 (no
  signal), the HerdR subscription connection closes, the endpoint is gone (`health` exits 1 afterwards),
  the same session accepts a fresh daemon, and a second stop stops that one too.

## Reconciliation pass (strict endpoint classification, ACK target, deadline, exit code)

Parent review found four concrete defects; all are fixed with regression tests.

1. **`controlEndpointClosed` classified "unknown" as "stopped".** It used
   `lstat(path).catch(() => null)` (any error ⇒ gone) plus `probeControlSocket` guarded by
   `catch { return true }`. Now, in `src/plugin/control.ts`:
   - POSIX: `await lstat(path)` ⇒ still present (not closed); only `isMissing` (ENOENT) ⇒ closed;
     every other error (EACCES/EPERM/ELOOP…) is rethrown as `ControlUnavailable(path, "read", error)`
     — permissions are never proof of a clean stop.
   - Windows: `absent` ⇒ closed; `present` and `occupied` ⇒ keep polling; the exhaustive `default`
     throws `ControlUnavailable(path, "connect")`. `WindowsPipePresence` is
     `"absent" | "present" | "occupied"` (`src/plugin/windows-pipe.ts:142`), so the previous
     `!== "present"` silently treated a closing instance's `occupied` name as gone.
   - The liveness `probeControlSocket` is no longer used in the stop path: an entry that still exists
     is not closed, whatever the probe says.
2. **The stop acknowledgement was not compared with the target.** `stopControl` now rejects with
   `ControlProtocolError(path, "stop acknowledged a different daemon")` unless `identity`, `pid` and
   `startedAt` all equal the health-derived target, and it never proceeds to wait/report success.
3. **`healthControl` ignored the stop budget.** The probe now receives `deadline - Date.now()`
   (still bounded by the 5 000 ms overall deadline) instead of silently spending its own 500 ms
   default outside the deadline.
4. **`runControlCli` pinned the runner's exit code.** The absent-daemon `stop` assertion now runs in a
   subprocess (`runIsolatedControlCli`: `bun index.ts <command>` with `HERDR_SOCKET_PATH`), so no
   in-process `process.exitCode = 1` is ever set.

### New regression tests

- `test/plugin/control-socket.test.ts` — "refuses a stop acknowledgement that names another daemon
  instance": a fake listener answers health for `pid: 41` and a stop ACK for `pid: 42`; `stopControl`
  rejects `ControlProtocolError`, the stop was attempted once, and the endpoint still answers.
- "never reports a stop as complete while the endpoint is still there": a real server whose
  `stopRequested()` does nothing → `stopControl(path, 250)` rejects `ControlUnavailable` and health
  still reports the same daemon.
- `posixTest` "treats an endpoint it cannot inspect as unproven, not as stopped": after
  `chmod 0o000` on the containing directory (and only when the lookup is actually denied),
  `stopControl` rejects `UnsafeControlSocket` (`lstat_failed`) instead of succeeding.
- `test/plugin/control.test.ts` — the second `stop` against a stopped endpoint is observed through
  `runIsolatedControlCli` (`exitCode === 1`, empty stdout, non-empty stderr).

## Limits / not covered

- The `pendingStop` backpressure branch (partial acknowledgement write completed from `drain`) is not
  exercised by a test: the frame is far below any pipe/socket buffer, so producing a short write would
  need an artificial transport. It is documented behavior, not a verified path.
- OS-level `lstat` denial (EACCES) can only be produced on POSIX and is `skip` on this host:
  **NOT RUN** on macOS/Linux. On Windows the equivalent strictness is the `present`/`occupied` ⇒
  "not closed" branch, exercised by the "endpoint still there" test.
- POSIX-only assertions (inode/uid/symlink/`0600`, POSIX endpoint removal) are `skip` on this host:
  **NOT RUN** on macOS/Linux. Windows SID/DACL/pipe guarantees are unchanged and still covered by
  `test/plugin/windows-control.test.ts` and `test/plugin/windows-security.test.ts` (green).
- If a client half-closes with a partial acknowledgement pending, the daemon deliberately does not
  request shutdown and the CLI reports a timeout instead. Safe failure mode, not tested.
- `state:` in `tasks.md` was left as-is (owned by the orchestrator); only the T1 checkboxes that are
  green were ticked. The rollback line stays unticked — nothing was rolled back.
