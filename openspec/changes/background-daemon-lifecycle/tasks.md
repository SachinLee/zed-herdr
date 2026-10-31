# 后台 daemon 生命周期实施任务

- 当前阶段：`awaiting-acceptance`；质量档位：`critical`；规划结果：`READY`；交付时间：`2026-10-31T13:04:42+08:00`。
- 用户已经授权后台 daemon、显式 stop、OpenSpec 初始化及继续执行；主会话可按本任务实施，无需重复征求同范围许可。本规划只新增三个规划文件，没有实现生产代码或测试。
- 需求来源：本 change 的 `proposal.md` 与 `specs/daemon-lifecycle/spec.md`。spec 没有 AC 编号，`covers` 使用 `design.md` 验收追溯表的稳定别名，英文验收引文逐字保留。
- 执行顺序为 T1 → T2 → T3。同一时间只允许一位 writer 改动共享的 `src/cli.ts` / `src/app.ts` / 控制集成测试；不为形式并行拆分写同一个文件的任务。不另建 tickets 或第二套计划。
- 标准选择：仓库 `AGENTS.md`、`package.json`、`tsconfig.json` 的当前磁盘版本，以及 `C:\Users\shuan\.agents\skills\project-standards\references\common.md`。该 skill 没有 Bun/TypeScript 专属参考，未加载 Java 等无关规范。
- 全部命令在 `D:\my-works\herdr-plugin\zed-herdr` 执行。实现前加载 `tdd`；各片完成后再将本片 `state` 改为 `done`，证据归主会话写入本 change 的 `artifacts/verification.md`。下面验证命令是计划，尚未执行。
- 规划验证（2026-10-30）：通过 `openspec_compat.py` 的 CLI 边界执行 OpenSpec 1.14.1 `validate background-daemon-lifecycle --strict --json`，结果 `valid: true` / `issues: []`；只读脚本逐字验证九个 Requirement 完整块均已内联、三片 metadata/上下文齐备、34 个 context 绝对路径存在。`git diff --check` 通过。应用测试为 `NOT RUN`，本次仅编写规划。
- 2026-10-30 进度：T2 已接入后台启动、日志与 `start`，并先行移除 pane manifest、更新部分文档；T2/T3 验收仍未完成，详见 `artifacts/verification.md`。T3 仍受 T2 阻塞，已做部分工作不代表该片完成。
- 2026-10-31 交付：T1/T2/T3 done；真实隔离 HerdR 0.9.5 更新演练和 live transport 已通过。full review 的 F1 stop deadline 阻断项已修复，RED/GREEN 和最终 full check（162 pass / 17 skip / 0 fail）通过；一次 full + 一次 focused 独立 review，最终 `CLEAN`。Linux/macOS 为 `NOT RUN`，原始 RED 未保存及未执行回滚演练均如实记录。待用户验收，未提交/推送/归档。

### 切片 1：安全停止并等待 scoped cleanup

```yaml
id: T1
covers: [stop]
blocked_by: []
state: done
writer: workflow-implementer
```

- [x] 行为：`stop` 通过已验证身份的本地控制端点停止指定 daemon，收到 ACK 后等待清理完成；无实例、错误 owner/identity、超时均失败，不启动或 signal 任何进程。保持 health JSON/no-start。
- [x] 代码边界：`src/plugin/protocol.ts`、`src/plugin/control.ts`、`src/app.ts`、`src/cli.ts`；测试为 `test/plugin/control-socket.test.ts`、`test/plugin/control.test.ts`、`test/plugin/windows-control.test.ts`、`test/plugin/windows-security.test.ts`、`test/e2e/daemon.test.ts`。现有 Windows 安全辅助模块只读。
- [x] 测试接缝：真实 socket/pipe NDJSON、health → stop 的实例条件比较、注入 shutdown 回调、真实 built `daemon` 与 CLI、HerdR 订阅关闭及运行中工作取消。
- [x] RED：新增“完整 ACK 先于 shutdown”“命令拒绝其他命令的成功响应”“health 与 stop 间实例替换不停止新实例”“无实例 stop 不 spawn”“错误 owner/identity 不发送 stop”“stop 无 signal 副作用”“超时非零”“scope cleanup 后关闭端点且进程 exit 0”“停止后同 session 再启动”；当前缺少 stop schema/dispatch，预期失败。
- [x] 实现：按 D3/D4 新增 stop request/response 与 exact validation、客户端 5,000 ms 总 deadline、一次性 ACK-close 回调、外层 control/内层 app scope；不改同步核心。只有新增断言暴露问题才调整自有 guard 清理。
- [x] GREEN：`bun run build` 后执行 `bun test test/plugin/control-socket.test.ts test/plugin/control.test.ts test/plugin/windows-control.test.ts test/plugin/windows-security.test.ts test/e2e/daemon.test.ts`。
- [x] 验证：`bun run typecheck`、`bun run lint`；mock 不得替代 built daemon 的正常 exit 0/订阅关闭断言。未运行的其他平台明确 `NOT RUN`。
- [x] 依赖：无；从当前 dirty 基线继续，不还原已完成工作。
- [ ] 回滚：尚未引入 detached 启动，可局部撤回本片 stop 接口与 scope 差异，保留旧 daemon/health/toggle；若用于后续片回滚，必须先用当前 stop 关闭后台实例。

上下文包（分派时连同下面整段传入）：

```text
Active change: openspec/changes/background-daemon-lifecycle/
Assigned slice: Slice 1 / stop
Phase: implement
Read: 本包内联验收、D3/D4 结论；下列绝对路径生产/测试文件。
Must preserve: Windows SID/DACL/pipe 与 POSIX UID/inode/symlink/64 KiB/fatal UTF-8；generation/cycle；directory 默认；health/toggle 不启动。
```

验收原文：

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

内联实施结论：

- 设计：D3 的 stop request 携带 `{identity,pid,startedAt}`；响应 `{ok:true,stopping:true,daemon}`。先 health 验证，再条件 stop；服务端拒绝更换后的实例。5,000 ms 总 deadline，25 ms 观察关闭；ACK 不是完成。helper 校验自身成功形状，health 不能误收含 daemon 的 stop ACK。客户端无 signal；启动锁早已由 hook finally 释放，stop 不抢删锁。
- 设计：D4 外层 scope 持有 control，内层持有同步/source/queue；Deferred 与 `daemon.run` 竞争并等待中断清理，最后关端点，不 `process.exit`。ACK 完整写出并经连接关闭/发送完成观察后才触发 Deferred。
- 已定位：`src/plugin/protocol.ts:31 ControlRequest` / `:77 ControlResponse` 是 union；`src/plugin/control.ts:524 isExactControlResponse` 必须同步扩展；`:561 responseFor` 分派；`:1022 requestControl` 已在写入前做 owner/inode 校验；`:1280 healthControl` 可复用。
- 已定位：`src/plugin/control.ts:833 close` 有 POSIX preserve/guard；`:999 close` 是 Windows listener shutdown。`src/app.ts:55 Effect.acquireRelease` 与 `:79 daemon.run` 是 scope 改动点。`src/cli.ts:20 commandFailed` 保留 4,096 字符及 exit 1。
- 已定位：`test/plugin/control-socket.test.ts:56 rawRequest` 已处理分片/drain，可用于 ACK 顺序；`:748` / `:764` 是 replacement/symlink 回归。`test/plugin/windows-control.test.ts:219` 记录立即 end 会丢未刷写 pipe 字节；`test/plugin/windows-security.test.ts:143 classifyWindowsPipeOwner` 纯函数表与 `:173` 同账号伪造场景必须保留，不声称 JSON identity 是认证。
- 现成模式：`src/app.ts:62 Runtime.runPromise(runtime)(Queue.offer(...).pipe(Effect.asVoid))` 可照搬 Promise → Deferred 桥；`test/plugin/control.test.ts:104 runControlCli` 捕获/恢复 console 与 exitCode；`test/e2e/daemon.test.ts:165 HerdRServer` 和 `:373 spawnDaemon` 提供真实 process fixture。原 `:382 stopDaemon` 的 SIGTERM 只保留为测试应急清理，新 stop 场景必须走 CLI。
- 规范简报：Bun、Effect 3、strict TS、`.ts` imports；namespace Effect 与 scoped finalizer；plugin 仍为 Promise/Bun。顶层 bun:test，不测试实现文本；finally 清理资源，恢复 spies。复用现有安全校验，不增加依赖、不修改 bun.lock。
- Verification: `bun run build`，`bun test test/plugin/control-socket.test.ts test/plugin/control.test.ts test/plugin/windows-control.test.ts test/plugin/windows-security.test.ts test/e2e/daemon.test.ts`，`bun run typecheck`，`bun run lint`。预期完整 ACK、正常 exit 0、无 signal、资源先清理、stop 失败不触及外部资源。
- 需要新打开 / May modify：`D:\my-works\herdr-plugin\zed-herdr\src\plugin\protocol.ts`、`D:\my-works\herdr-plugin\zed-herdr\src\plugin\control.ts`、`D:\my-works\herdr-plugin\zed-herdr\src\app.ts`、`D:\my-works\herdr-plugin\zed-herdr\src\cli.ts`、`D:\my-works\herdr-plugin\zed-herdr\test\plugin\control-socket.test.ts`、`D:\my-works\herdr-plugin\zed-herdr\test\plugin\control.test.ts`、`D:\my-works\herdr-plugin\zed-herdr\test\plugin\windows-control.test.ts`、`D:\my-works\herdr-plugin\zed-herdr\test\plugin\windows-security.test.ts`、`D:\my-works\herdr-plugin\zed-herdr\test\e2e\daemon.test.ts`。
- 禁止修改：其他源码、manifest、依赖、其他 change、legacy 指针。超出范围或结论与磁盘不符时向主会话升级；返回文件、RED/GREEN 实际结果、未运行项与剩余风险。

### 切片 2：共享后台启动、有界日志和会话继承

```yaml
id: T2
covers: [hooks, environment, readiness, start, logging, posix, health]
blocked_by: [T1]
state: done
writer: workflow-implementer
```

- [x] 行为：hook 和 `start` 在原 token 锁下启动/复用同一后台实例，无 pane，父进程退出后 daemon 继续工作；继承 session/config，清除 paneId；就绪失败有界且释放锁；后台日志单文件最多 1 MiB。
- [x] 代码边界：`src/plugin/hook.ts`、新增 `src/plugin/daemon-process.ts`、新增 `src/plugin/daemon-log.ts`、`src/app.ts`、`src/cli.ts`；`test/plugin/hook-unit.test.ts`、`test/plugin/control.test.ts`、新增 `test/plugin/daemon-process.test.ts`、新增 `test/plugin/daemon-log.test.ts`。控制协议与平台安全 helper 保持 T1 版本。
- [x] 测试接缝：注入 spawn/control/clock/sleep、实际 token 锁、argv/env 与 `unref`、临时文件字节数/权限、真实 CLI start/health/stop（同 source 入口可集成验证）。
- [ ] RED：更新原 pane opener 测试；验证二十个 hook 和混合 hook/start 仅一次 spawn、重复 start pid/startedAt 不变、不完整 hook 无 I/O、1,500 ms 总预算、不安全/协议失败不 spawn、早退/就绪超时取消自有句柄并可重试、所有环境继承但 paneId null、不可写日志无 spawn/非零、跨容量多次写仍 ≤1 MiB/零备份/合法 JSON、runtime logger 实际进入该文件。
- [x] 实现：D1/D2 共用 ensureDaemon 与原锁；D5 单文件整行截断、16 KiB 记录限制、foreground console/background file logger；不得引入 supervisor、PID 文件或新公开配置。保留配置默认 directory 与 generation。
- [x] GREEN：`bun test test/plugin/hook-unit.test.ts test/plugin/daemon-process.test.ts test/plugin/daemon-log.test.ts test/plugin/control.test.ts`（由 full `bun run check` 覆盖）。
- [x] 验证：`bun run typecheck`、`bun run lint`、`bun run build`；真实后台存活/更新 E2E 由 T3 完整收口，不把注入测试当作平台证明。
- [x] 依赖：T1 done；已解除阻塞并完成 T2。
- [ ] 回滚：先 disable 并使用 T1 stop，确认后台关闭后仅撤回 T2 新模块/差异，回到 pane startup；不删除他人文件或当前会话数据。

执行说明：原始 RED 未完整保存，上述 RED checkbox 保留未勾选。本轮三项日志/故障清理回归实际 RED/GREEN 和全部 GREEN 见 `artifacts/verification.md`；回滚是未执行的恢复方案，POSIX 实机测试为 `NOT RUN`，不代表已有失败被忽略。

上下文包：

```text
Active change: openspec/changes/background-daemon-lifecycle/
Assigned slice: Slice 2 / hooks, environment, readiness, start, logging, posix, health
Phase: implement
Read: 本包内联验收与 D1/D2/D5；下列绝对路径文件。
Must preserve: 原 token/inode 锁、Windows SID/DACL/pipe、POSIX owner socket；T1 stop；directory 默认；generation/cycle。
```

验收原文：

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

### Requirement: Health reports background daemons

`health` SHALL report a detached daemon without requiring a HerdR pane, and SHALL NOT start a daemon.

#### Scenario: Background daemon health

- **WHEN** the daemon was started detached and answers `health`
- **THEN** the response is `ok: true` with `paneId: null` plus the daemon identity, pid, start time, and protocol status

#### Scenario: Health starts nothing

- **WHEN** `health` runs and no daemon answers
- **THEN** the command exits with status 1 and no daemon process is started

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

内联实施结论：

- 设计：同文件抽 ensureDaemon；一个 1,500 ms deadline；先 health，再锁内复查、日志预检、spawn、health，hook 最后 notify。仅 ControlUnavailable 可启动。锁 finally 原样保留。D2 绝对 argv + detached/windowsHide/三路 ignore/unref，复制 env 删除 HERDR_PANE_ID，内部 ZED_HERDR_BACKGROUND=1；超时仅取消本次自有句柄。
- 设计：D5 单 endpoint 固定日志文件，1,048,576 bytes、零备份，写入前整行 truncate 并重置 offset；记录 ≤16 KiB 且合法 JSON。父预检失败不 spawn，child 初始化失败不公布 readiness；source/core/outer logger 共用后端。写失败通过一次性失败通知触发 scoped cleanup，不递归记录失败。前台 console 不变。
- 已定位：`src/plugin/hook.ts:68 HookControlApi`、`:81 HookStartupOptions` 是注入接缝；`:537 acquireLock`、`:612 releaseLock` 保留；`:655 defaultOpenPane`、`:688 paneOpenArgv` 替换；`:746 runHook`、`:836 finally` 复用。`src/config.ts:44 projectMode` 缺省 directory。
- 现成模式：`test/plugin/hook-unit.test.ts:319` 的二十 contender + Promise.withResolvers；`:536` 的注入 now/sleep deadline；`:575` 的 fake timers finally restore。`src/app.ts:23 JsonLoggerLive` / `:24 HerdRClientLiveWithLogger` 不能继续固定 console；`node_modules/effect/src/Logger.ts:607 jsonLogger` + `:376 replace` 支持保留 JSON 编码。Bun 1.4.4 已具 detached/windowsHide/unref，仍需真实 E2E。
- 规范简报：Bun/strict TS/readonly/.ts imports，无依赖变化；plugin Promise/Bun 不搬进 Effect graph；文件操作校验 owner/type/identity，Windows 继承现有 profile ACL 假设，不回退共享 temp；小模块直接导入，不建 pass-through 层。bun:test 顶层、资源 finally；保留稳定日志字段。
- Verification: `bun test test/plugin/hook-unit.test.ts test/plugin/daemon-process.test.ts test/plugin/daemon-log.test.ts test/plugin/control.test.ts`；`bun run typecheck`；`bun run lint`；`bun run build`。观察并发仅一次 spawn、配置继承、日志上限、锁清理；T3 负责实际 OS detached 证明。
- 需要新打开 / May modify：`D:\my-works\herdr-plugin\zed-herdr\src\plugin\hook.ts`、`D:\my-works\herdr-plugin\zed-herdr\src\app.ts`、`D:\my-works\herdr-plugin\zed-herdr\src\cli.ts`、`D:\my-works\herdr-plugin\zed-herdr\test\plugin\hook-unit.test.ts`、`D:\my-works\herdr-plugin\zed-herdr\test\plugin\control.test.ts`。允许新建：`D:\my-works\herdr-plugin\zed-herdr\src\plugin\daemon-process.ts`、`D:\my-works\herdr-plugin\zed-herdr\src\plugin\daemon-log.ts`、`D:\my-works\herdr-plugin\zed-herdr\test\plugin\daemon-process.test.ts`、`D:\my-works\herdr-plugin\zed-herdr\test\plugin\daemon-log.test.ts`。
- 禁止修改：锁平台 helper、协议、同步核心、依赖、manifest、其他 change/指针。新边界需求或事实冲突返回主会话；返回文件与 RED/GREEN/NOT RUN/风险。

### 切片 3：无 pane 插件入口、更新流程与跨平台验证

```yaml
id: T3
covers: [update]
blocked_by: [T2]
state: done
writer: main
```

- [x] 行为：manifest 不再声明 daemon pane；README 与内部文档给出后台操作、日志检查、明确 stop 的更新/移除流程；实测 disable/stop/build/enable/start 后只剩当前实例。
- [x] 代码边界：`herdr-plugin.toml`、`README.md`、`docs/plugin.md`、`docs/runtime.md`、`docs/architecture.md`；`test/plugin/hook-unit.test.ts` manifest fixture、`test/e2e/daemon.test.ts`。只因 E2E 暴露实际失败才由原 writer 回到对应片修复，不跨文件盲补。
- [x] 测试接缝：Bun.TOML.parse manifest，真实 built CLI/hook 退出、fake HerdR/真实文件日志/fake Zed recorder、隔离 bundle 的停止/替换/重新启动。
- [ ] RED：manifest fixture 先要求无 panes；新 E2E 先要求 hook/start 父退出后 health paneId null，混合并发仅一个实例，Zed 收到相同配置/目录路径，stop 后订阅关闭且实例退出，再替换隔离 bundle、重启 startTime 晚于 build。旧 manifest 与未完成生命周期会失败。
- [x] 实现：只移除 pane 配置并更新对应文档/fixtures；两个事件/toggle action 保留。README 固定 disable → stop → build → enable → start，说明 stop 失败先处理、首次迁移旧前台实例正常退出、无需 fabricated paneId、单文件 1 MiB/零备份。
- [x] GREEN：`bun run build` 后执行 `bun test test/plugin/hook-unit.test.ts test/e2e/daemon.test.ts`（由 full check 覆盖）。
- [x] 验证：`bun run check`；Windows Bun 1.4.4 通过，Linux/macOS 不可用已记录 `NOT RUN`，不伪造 POSIX parity。完整保留原 S1/subscription/S2、reconnect、directory 回归。
- [x] 操作验证：在受支持 HerdR 隔离会话照 README 执行 disable、stop、build、enable、start、health；记录 build 完成时间、新 startedAt、PID/实例变化与重复 start 不变、无 daemon pane。自动 E2E 用隔离 bundle 验证进程更替，不声称 fake HerdR 验证了真实 plugin enable/disable。
- [x] 依赖：T2 done；已解除阻塞并进入 T3 收口。
- [ ] 回滚：disable → 当前 stop → 确认退出 → 还原本 change 差异 → build → enable；不把 pane 配置恢复与未停止的后台实例同时发布。
- [x] 收口：所有实现和检查完成后主会话调度一次 full 独立 review，必要时最多一次 focused repair review；已执行 full + focused，F1 解决、最终 `CLEAN`。平台缺口明确保留，不宣称用户已验收/归档。

执行说明：真实 HerdR 演练已通过，原始结果见 `artifacts/real-herdr-evidence.json`。原始 manifest/startup RED 未完整保存，RED checkbox 保留；回滚仅记录方案而未撤回实现。full review 的 F1 已经修复、复验并由 focused review 确认 `CLEAN`，详见 `artifacts/verification.md` 和两份 review 记录。

上下文包：

```text
Active change: openspec/changes/background-daemon-lifecycle/
Assigned slice: Slice 3 / update
Phase: implement
Read: 本包内联 update 验收、集成回归结论及下面绝对路径。
Must preserve: 两个 workspace hooks、toggle action、Windows/POSIX 安全、S1/ack/S2、generation/cycle、directory 默认；不结束其他 panes。
```

验收原文（本片主验收）：

### Requirement: Plugin update keeps exactly one current daemon

The operator procedure SHALL stop the running daemon before rebuilding the plugin and start a
single fresh daemon afterwards, in the documented order: disable, stop, build, enable, start.

#### Scenario: Documented update order

- **WHEN** the README update procedure is followed in order
- **THEN** the daemon is stopped before the build writes `dist/index.js`, and the final `start` produces a daemon whose start time is later than the build

#### Scenario: Update leaves one daemon

- **WHEN** an update completes
- **THEN** exactly one daemon answers `health` and no daemon started from the previous build remains

内联实施结论：

- 设计：D6 只删 manifest panes；显式前台 daemon/开发脚本保留。enable 可能先启动，最后 start 幂等复用。stop 非零不能继续 build；旧版不认识 stop 时，先让原前台 daemon 正常退出。日志一 endpoint 一文件，1 MiB/零备份；无 PID 文件与自动更新服务。
- 集成回归结论：T1 已交付 owner + identity/pid/startedAt 条件 stop、完整 ACK 后清理、最后关闭端点；T2 已交付同一 token 锁下 hook/start、1,500 ms 就绪预算、环境继承且移除 HERDR_PANE_ID、后台 health paneId null、单文件上限。复用这些公开行为测试：父退出仍可达、重复 start 实例不变、stop 后旧实例退出、Zed 收到目录模式路径、日志存在且有界；不重新设计接口。
- 已定位：`herdr-plugin.toml:20` / `:24` 是保留事件，`:28 [[panes]]` 删除。`test/plugin/hook-unit.test.ts:60` TOML fixture 要同步。`README.md:29`、`:56`、`:74`、`:166`、`:171` 仍有 pane/旧移除流程；`docs/runtime.md:17` CLI 集合、`docs/plugin.md:161` startup、`docs/architecture.md:71` hook 时序图均需更新。
- 现成模式：`test/e2e/daemon.test.ts:38 resolveArtifactPath` 支持绝对 `ZED_HERDR_TEST_DIST`；`:165 HerdRServer`、`:234 RecorderServer`、`:354 writeFakeZed` 跨平台复用；`:365 daemonEnvironment` 已隔离 Windows LOCALAPPDATA；`:543` / `:599` 是不能删除的 directory 场景。每个真实后台测试 finally 用自己会话 control stop，必要时仅清理测试亲手创建的子进程句柄。
- 规范简报：顶层 bun:test，观察 CLI/NDJSON/argv/资源退出，不 grep 实现文本；每次运行 built E2E 前先 build；Windows 不用 shebang/.cmd 冒充可执行 Zed；使用现有 compileWindowsFakeZed，POSIX 不加载 Windows API。README 是操作步骤的所有者，内部文档只同步受影响说明，不改依赖/基线。
- Verification: `bun run build`，`bun test test/plugin/hook-unit.test.ts test/e2e/daemon.test.ts`，`bun run check`；Windows/Linux/macOS 重复 targeted E2E。真实 HerdR 步骤逐项 `herdr plugin disable artisann.zed-herdr`、`bun ./dist/index.js stop`、`bun run build`、`herdr plugin enable artisann.zed-herdr`、`bun ./dist/index.js start`、`bun ./dist/index.js health`；失败停止后续操作。记录实际执行与 `NOT RUN`。
- 需要新打开 / May modify：`D:\my-works\herdr-plugin\zed-herdr\herdr-plugin.toml`、`D:\my-works\herdr-plugin\zed-herdr\README.md`、`D:\my-works\herdr-plugin\zed-herdr\docs\plugin.md`、`D:\my-works\herdr-plugin\zed-herdr\docs\runtime.md`、`D:\my-works\herdr-plugin\zed-herdr\docs\architecture.md`、`D:\my-works\herdr-plugin\zed-herdr\test\plugin\hook-unit.test.ts`、`D:\my-works\herdr-plugin\zed-herdr\test\e2e\daemon.test.ts`。
- 禁止修改：其他源码、依赖、其他 change/legacy 状态。实施缺陷返回对应 writer；返回变更文件、RED/GREEN、平台版本/缺口、真实插件步骤证据与剩余风险。
