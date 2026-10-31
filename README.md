# Zed Workspace Sync

[![Plugin Demo](https://img.youtube.com/vi/Q_i-IKda7hE/maxresdefault.jpg)](https://youtu.be/Q_i-IKda7hE)

HerdR plugin `artisann.zed-herdr` keeps the active HerdR workspace available in Zed without taking ownership of either application. It supports macOS, Linux, and native Windows, HerdR **0.7.3+** reporting protocol **16 or newer** (tested through protocol **22**), Bun, and Zed with its `zed` CLI available. The default `directory` mode opens the selected directory and works without Git; the opt-in `git-root` mode requires Git.

For contributor architecture and subsystem internals, see [the documentation index](docs/README.md).

## Build and install

Run plugin commands from a HerdR environment (`HERDR_ENV=1`), then build and link this checkout:

```bash
cd zed-herdr
bun install --frozen-lockfile
bun run build
herdr plugin link .
herdr plugin enable artisann.zed-herdr
```

On Windows, run these commands in PowerShell inside HerdR. If Zed is not on `PATH`,
set `$env:ZED_BIN` to the full path of its CLI executable before starting the daemon.
Use an executable such as `zed.exe`, rather than a `.cmd` or `.bat` wrapper. Paths
containing spaces are supported. No project-mode setup is required: the default
`directory` mode opens the selected directory itself, including a non-Git parent
containing several repositories. Set `$env:ZED_HERDR_PROJECT_MODE = "git-root"` before
starting HerdR only when you want Git-root resolution.

Linking makes the local checkout available to HerdR; enabling activates its hooks. A `workspace.created` or `workspace.focused` hook starts one detached daemon when needed, with no daemon pane. You can also run `bun dist/index.js start` to start it explicitly; repeated starts reuse the existing instance.

For direct development, run the same daemon without the plugin host:

```bash
bun run dev
# or, without watch mode:
bun run start
```

Both commands require access to the current HerdR session socket. The built artifact can also be started directly with `bun ./dist/index.js daemon`.

## Health and inspection

Ask the daemon on the current session's control socket for its health:

```bash
bun dist/index.js health
```

A successful response is JSON shaped like:

```json
{
    "ok": true,
    "daemon": {
        "identity": "artisann.zed-herdr:daemon",
        "paneId": null,
        "pid": 1234,
        "startedAt": "2026-01-01T00:00:00.000Z",
        "protocol": 22,
        "beyondTested": false
    }
}
```

`identity` identifies this plugin's owner-validated local daemon, `paneId` is `null` for a detached daemon, and `pid`/`startedAt` identify that daemon instance. `protocol` is the last protocol accepted from HerdR, or `null` before negotiation; `beyondTested` is true when it is newer than protocol 22. Exit status `1` means no valid matching daemon answered; it does not start one.

Use the plugin registry and plugin log to inspect the installation:

```bash
herdr plugin list --plugin artisann.zed-herdr --json
herdr plugin log list --plugin artisann.zed-herdr --limit 100
```

The detached daemon writes JSON logs to a single endpoint-specific `.log` file beside the control socket on macOS and Linux, or under `%LOCALAPPDATA%\zed-herdr\logs` on Windows (the user profile is the fallback). The file is capped at 1 MiB and truncated without backups. Foreground `daemon` output remains on the terminal.

## Configuration and behavior

Set `ZED_BIN` to a non-empty executable path to select a Zed CLI explicitly:

```bash
export ZED_BIN=/absolute/path/to/zed
```

Without `ZED_BIN`, the daemon resolves `zed` from `PATH`; on macOS an executable-not-found result also tries Zed's standard application CLI path. It invokes only `zed -e <absolute-project-path>`.

`ZED_HERDR_PROJECT_MODE` controls which directory Zed opens:

| Value                 | Behavior                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `directory` (default) | Open the selected directory itself, including a non-Git parent containing several repositories. |
| `git-root`            | Resolve the selected directory to its Git root; skip non-Git directories.                       |

Set this before starting the daemon or the HerdR process that launches its hooks only when
overriding the default:

```bash
export ZED_HERDR_PROJECT_MODE=git-root
```

In PowerShell, use `$env:ZED_HERDR_PROJECT_MODE = "git-root"`. Restart an already running plugin daemon to apply the setting. Directory mode does not scan for nested repositories or promote the selected directory to a Git root. Both modes prefer HerdR's checkout path, then the matching plugin cwd hint, and require an accessible directory. Other values, including an empty value, fail configuration validation.

For HerdR transport, `HERDR_SOCKET_PATH` takes precedence. Otherwise the socket is resolved as:

1. `$XDG_CONFIG_HOME/herdr/sessions/$HERDR_SESSION/herdr.sock` for a named session, or `~/.config/herdr/sessions/$HERDR_SESSION/herdr.sock` when `XDG_CONFIG_HOME` is unset.
2. `$XDG_CONFIG_HOME/herdr/herdr.sock`, or `~/.config/herdr/herdr.sock`, when there is no named session.

On Windows, the default marker path is `%APPDATA%\herdr\herdr.sock`, with named sessions under
`%APPDATA%\herdr\sessions\<name>\herdr.sock`. `XDG_CONFIG_HOME` overrides the configuration base.
`HERDR_SOCKET_PATH` still takes precedence and must contain the marker-file path, without a
`\\.\pipe\` prefix. The client derives the named-pipe address from that path and connects directly
using Bun. The marker file alone does not establish whether HerdR is running.

Windows control-channel support assumes a trusted local environment. The daemon relies on
Windows' default named-pipe access controls and the existing ACL of `%LOCALAPPDATA%` (or the user
profile). Pipe names include the current account SID, and clients inspect the named pipe's owner
before connecting. This check uses a separate native handle and does not authenticate the subsequent
Bun connection against endpoint replacement. A process running as the same account can occupy the
name first, impersonate the daemon, receive hook workspace paths, and prevent automatic startup.
The JSON `identity` field does not provide authentication. See
[the plugin security boundary](docs/plugin.md#lock-and-control-path-security) for details.

The daemon reads HerdR snapshots and lifecycle events, then asks Zed to add/focus a validated project directory. It never sends a mutating HerdR request, kills a process, reuses an existing pane, replaces Zed window/project state, accesses Zed's private storage, or uses Zed's state-replacing CLI options. Non-worktree workspaces wait for the plugin hook's workspace cwd hint; inaccessible paths are skipped, as are non-Git paths in `git-root` mode.

## Pause and resume Zed control

HerdR plugin manifests declare actions but do not install user keybindings. Add this command binding
to `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+shift+z"
type = "plugin_action"
command = "artisann.zed-herdr.toggle"
description = "Toggle Zed workspace sync"
```

Apply it to the running HerdR server:

```bash
herdr server reload-config
```

Then press the HerdR prefix followed by `Shift+Z`. Disabling interrupts in-flight synchronization
and suppresses new Zed calls while HerdR remains authoritative. Re-enabling requests a fresh
snapshot for the current generation.

The same action is available from the built CLI:

```bash
bun dist/index.js toggle
```

It prints `{"ok":true,"enabled":false}` or `{"ok":true,"enabled":true}`. A newly started daemon
begins enabled. This runtime pause is separate from `herdr plugin disable`, which disables the
action target but leaves the user-configured keybinding in place.

## Troubleshooting

- **Protocol mismatch:** HerdR must report protocol 16 or newer. A value below 16 is logged as `herdr_protocol_unsupported` and stops reconnecting rather than guessing or downgrading. Newer values are accepted; values above the highest tested protocol are reported by `health` with `beyondTested: true` and log `herdr_protocol_beyond_tested` once.
- **Socket or health failure:** confirm `HERDR_SOCKET_PATH`, `HERDR_SESSION`, and `XDG_CONFIG_HOME` describe the intended session, then inspect the plugin log and daemon log above. Focusing or creating a workspace will run the activation hook again.
- **Zed errors:** ensure `ZED_BIN` points to an executable, or that `zed` is on `PATH`; inspect the daemon output for the failed `zed -e` command. The daemon leaves HerdR and existing Zed state unchanged when Zed rejects or times out.

## Update

Disable hooks before stopping the existing instance, then rebuild and start the new one:

```bash
herdr plugin disable artisann.zed-herdr
bun dist/index.js stop
bun run build
herdr plugin enable artisann.zed-herdr
bun dist/index.js start
bun dist/index.js health
```

If `stop` fails, resolve the failure before rebuilding. When migrating from an older pane-based version, let the old foreground daemon exit normally before starting the new one.

## Disable or remove

For a linked checkout, stop future hook activation and remove the link:

```bash
herdr plugin disable artisann.zed-herdr
bun dist/index.js stop
herdr plugin unlink artisann.zed-herdr
```

For a plugin installed from a remote source instead of linked from this checkout, use:

```bash
herdr plugin uninstall artisann.zed-herdr
```
