# 后台 daemon 生命周期设计

## 背景与现状

- 本次质量档位为 `critical`：新增 `start` / `stop` CLI，并让本地控制协议承担进程退出请求；必须证明授权边界、资源清理和跨平台行为。
- 需求以本 change 的 `proposal.md`、`specs/daemon-lifecycle/spec.md` 为准。用户已授权后台启动、显式停止和继续实施；本规划不引入再次审批，也不代表已完成实现。
- `src/plugin/hook.ts:746 runHook` 已有“快速复用 → token 锁 → 锁内复查 → 启动 → 就绪 → finally 释放锁”的完整流程。`src/plugin/hook.ts:42 CONTROL_READINESS_MS` 为 1,500 ms，轮询 25 ms，陈旧锁阈值 5,000 ms。仅替换 pane 启动边，并让显式启动复用这条流程。
- `src/app.ts:42 runDaemon` 已有 scoped queue/control server，但 `src/app.ts:79 daemon.run` 没有控制通道退出接缝。`src/plugin/control.ts:1022 requestControl` 已在写请求前执行 POSIX inode/UID 或 Windows SID 校验。
- 当前磁盘包含之前完成但尚未提交的 Windows 与目录模式工作。`src/config.ts:44 decodeAppConfig` 的默认模式是 `directory`，`herdr-plugin.toml:5` 支持 Windows；这些是本次必须保持的基线。`AGENTS.md` 中仅 POSIX、默认 Git-root 和 pane 的旧描述不能覆盖已获授权的新行为。
- 项目没有已发布的 `openspec/specs/` capability，也未找到 ADR；本次决策可局部回退，不新增 ADR。交接中的 `test/plugin/hook.test.ts` 不存在，实际入口为 `test/plugin/hook-unit.test.ts`。

## 方案与改动边界

### D1：共用原锁与一个就绪预算

在 `src/plugin/hook.ts` 保留锁算法，抽出同文件内共享的 `ensureDaemon` 启动协调函数，供 `runHook` 和 `start` 使用；不复制锁，不增加常驻 supervisor。共享函数返回 `Started` / `AlreadyRunning` 与经校验的 daemon health。`runHook` 继续在缺少 workspace/cwd 时无 I/O 地返回 `Skipped`。

一次调用只创建一个 1,500 ms 就绪 deadline，目录准备、health、锁争用、锁内复查、日志预检、spawn、最终 health 与 hook notify 都消费剩余时间。只有 `ControlUnavailable` 能进入启动路径；协议错误、错误身份和不安全端点直接失败。健康检查在 notify 前确认身份，不把“能连接”当作就绪。`start` 不需要 hook payload，不发布虚构 cwd hint。

锁是短期启动锁，由发起调用在 `finally` 中按原 token/identity 释放；daemon 不继承该锁，也不在 stop 时删除其他调用的锁。停止成功时不应存在本实例遗留的启动锁。1,500 ms 小于既有 5,000 ms 陈旧阈值，保持现有争用规则。

### D2：Bun 原生 detached spawn

新增 `src/plugin/daemon-process.ts`，只负责构造启动参数和持有本次创建的子进程句柄。使用绝对路径 `[process.execPath, <当前 index.ts 或 dist/index.js>, "daemon"]`，不依赖调用者 cwd，不执行 shell，不调用 HerdR pane API。保留现有 `daemon` 前台入口以及 `bun run start` 的开发含义。

`Bun.spawn` 使用 `detached: true`、`windowsHide: true`、`stdin/stdout/stderr: "ignore"`，调用返回句柄的 `unref()`。复制调用方环境，仅删除 `HERDR_PANE_ID`，并覆盖内部启动标记 `ZED_HERDR_BACKGROUND=1`；保留会话路径、项目模式、Zed 路径、PATH、Windows profile 等配置。内部标记只选择日志后端，不是公开配置项。显式前台 `daemon` 仍可报告真实 paneId；后台启动始终为 `null`。

已核对 Bun 1.4.4 与本地声明：`node_modules/bun-types/bun.d.ts:6718 detached` 在 POSIX 使用 setsid、Windows 使用 detached process；`:6895 windowsHide`；`:7256 unref`。声明与文档不足以代替 E2E：必须让实际 hook/start 进程退出后再确认 daemon 仍可连接。

启动接缝注入 spawn、clock、sleep、control，替换 `openPane` / `openedPane` 为体现进程启动的名称。若本次子进程提前退出，就绪立即失败；若超时，取消只允许操作本次 `Bun.spawn` 返回的句柄，禁止从锁文件/health PID 构造 kill。取消和句柄回收不允许留下阻止 hook 退出的引用；finally 总是释放自己的 token。该取消仅用于未完成启动的自有子进程，已复用的 daemon 不受影响。

### D3：先确认实例，再提交 stop，ACK 后才中断

新增协议类型：

```text
StopControlRequest = { type: "stop", daemon: { identity, pid, startedAt } }
StopControlResponse = { ok: true, stopping: true, daemon: DaemonHealth }
```

`identity` 继续使用 `DaemonIdentity`，PID/时间复用现有有界 schema；新增响应进入 exact-key 校验，现有三个成功响应形状保持。各命令 helper 还必须验证响应属于自身：尤其 `healthControl` 不能仅凭含 `daemon` 属性便接受 stop ACK。失败仍使用现有 `invalid_request` / `server_failure` 等 token。请求携带的实例标识只是条件比较，不能替代 OS owner 校验。

`stopControl` 先通过现有 `healthControl` 获得已验证实例，校验 identity，再通过同一套 owner/inode/SID 检查发送 stop。服务端在任何停止副作用前比较自身的 identity、pid、startedAt；实例已更换、请求格式无效或未提供 stop handler 时失败，不能停止新实例。stop 成功响应必须匹配该目标。`stop` CLI 全程不 spawn、不读取 PID 状态文件、不调用任何 signal API。

服务端先完整写出 stop ACK，再在该连接关闭/发送完成后触发停止 Deferred；禁止先触发 Deferred 后 `socket.end`，也不能仅靠未经验证的 `setTimeout(0)` 猜测刷新完成。连接状态增加一次性停止回调，复用现有单帧和 completed 标志，socket write 失败不宣告成功。测试必须证明客户端收到完整 ACK，然后才触发运行时停止，重复回调幂等。

ACK 表示已接受停止请求，不等于清理完成。CLI 总预算 5,000 ms，包含两次请求与每 25 ms 的关闭观察，单次探测使用剩余预算。ACK 后仅观察控制端点：原实例健康仍可达则继续等，端点确认关闭才成功；超时或出现其他实例/身份则非零，绝不再次发送 stop 给新实例。POSIX 对消失/拒绝连接、Windows 对 pipe absent 作严格分类，不能把任意协议/权限错误当作退出成功。

### D4：Effect 内层先清理，控制端点最后关闭

`runDaemon` 增加停止 Deferred。控制监听器注册到外层 scope；应用 Layer、同步 fibers、HerdR source、队列/子进程放在可先退出的内层 scope。`daemon.run` 与 Deferred await 竞争；收到停止时中断并等待运行中的同步任务及其 finalizer，退出内层 scope，最后关闭外层 control server，正常返回 exit 0。失败仍传播，不能把真实 daemon 故障改成成功退出。日志句柄的 scope 最外层关闭。

这样 ACK 后原端点仍存在，直到 HerdR 订阅、同步工作和编辑器子进程已经清理完毕；客户端观察端点消失才有清理完成的依据。不使用 `process.exit` 提前越过 finalizer，不修改 generation/cycle 检查，也不把 lifecycle wire 类型传入同步核心。

`src/plugin/control.ts:833 startPosixControlServer.close` 已有 preserve/guard 机制，`listener.stop(true)` 必须继续只清理由本实例拥有的入口。用“停止后再启动”验证 guard 最终消失；若需补清理，只能凭捕获的 guard inode 删除，不得简化原 replacement/symlink 保护。Windows 继续关闭自己绑定的 listener，由内核删除 pipe。

### D5：daemon 自己维护一个有界 JSON 日志

新增 `src/plugin/daemon-log.ts`，提供路径推导、可写预检、`writeLine` 和关闭句柄，不增加后台日志进程、队列服务或依赖。路径由同一 control endpoint 推导：POSIX 使用 socket 的同目录 `<digest>.log`；Windows 使用 `windowsStateRoot(environment)` 下 `logs/<control-digest>.log`。命名固定，不按 PID/日期新增文件。只保留一个文件，最大 **1 MiB (1,048,576 bytes)**，备份数量 **0**；下一整条记录会超过上限时，先 truncate 再写。单条最大 **16 KiB**；超大诊断替换为合法、有界 JSON 截断记录，不能截断 UTF-8/JSON 字节造成坏行。

先在持启动锁、确认无活实例后做打开/权限/写入预检；失败由 hook/start 的既有 4,096 字符 CLI 错误路径报告，且不 spawn。子进程在公布 control readiness 前实际初始化同一路径日志并写启动记录，失败即非零退出，父调用报告有界启动失败。预检到 child 打开之间仍可能失败，父调用必须观察子进程早退，不能将“spawn 成功”报告为启动成功。

采用 Bun 支持的文件描述符顺序写入和 truncate（允许现有低层文件模块所用 `node:fs` 兼容 API），每条写入前按字节计数；打开时若已有文件超限，先安全截断。截断后写入位置必须归零或使用追加语义，不能在旧 offset 写出稀疏大文件。不使用无限 Promise 队列或不设上限的 stdout 重定向。保留正常日志的 JSON 结构与稳定 `workspace_sync_*` 事件、字段。Effect 后端可用 `Logger.map(Logger.jsonLogger, writeLine)` 与 `Logger.replace`，但必须参数化 `src/app.ts:23` 的 logger Layer，覆盖 source/core/outer daemon，避免内层 `Logger.json` 又写入已忽略的终端。前台 daemon 保留 console JSON logger。

POSIX 复用已验证的 0700 目录，日志拒绝 symlink、非普通文件、异 UID、多硬链接及不稳定 inode，文件 0600，基于捕获 fd 截断，不跟随路径替换。Windows 复用现有 per-user state root/继承 ACL 的信任模型，拒绝异常路径类型，不伪称验证了 DACL。不得回退到共享临时目录。运行中写入失败通过一次性失败通知使 `runDaemon` 的竞争等待失败，走同样的 scoped cleanup；不要从 logger 回调直接 `process.exit`，也不要把写失败再次递归写入同一个 logger。禁止继续同步却静默丢弃全部诊断；不新增自动重启。同步小文件写入对事件循环的影响列为验证风险。

### D6：入口迁移和更新顺序

移除 manifest 的 `[[panes]] daemon`，保留两个 workspace hooks 与 toggle action；不增加安装时常驻启动或 OS service。CLI 精确接受一个命令 `daemon|hook|health|toggle|start|stop`；无效参数 exit 2，命令失败沿用 exit 1。`start` 输出可区分 `started` / `already_running` 的成功 JSON 与实例信息；`stop` 在观察到关闭后输出成功 JSON。`health` 的既有 JSON 字段不变。

README 记录后台自动启动、显式启动/停止、`paneId: null`、日志路径和大小/保留限制；更新顺序固定为：

```bash
herdr plugin disable artisann.zed-herdr
bun ./dist/index.js stop
bun run build
herdr plugin enable artisann.zed-herdr
bun ./dist/index.js start
bun ./dist/index.js health
```

每步检查结果；stop 非零时先处理失败，不能继续覆盖 bundle；首次安装没有旧 daemon 时使用安装流程。enable 可能已触发 hook，最终 start 必须复用这个新实例。已运行的旧版本不认识 stop 时，先在原 daemon 终端用正常退出完成清理，再进入新流程；不提供猜 PID/强杀迁移。禁止读取或关闭其他 HerdR panes。

更新 `docs/plugin.md`、`docs/runtime.md`、`docs/architecture.md` 中实际受影响的旧生命周期文字/图，不扩展到无关文档或重写历史基线。

## 备选方案与否决理由

| 方案 | 结论与依据 |
| --- | --- |
| 继续创建不聚焦 tab / 隐藏 pane | 不满足无 pane、headless 的已接受需求。 |
| shell `&`、PowerShell Start-Process、操作系统 service | Bun 原生 detached 已覆盖所需能力；额外入口增加平台差异和部署要求。 |
| PID 文件配合 kill / taskkill | 不能保证目标实例与 owner，绕过 scoped cleanup；stop 明确禁止。 |
| 收到 stop 后立即退出 | ACK 可能丢失，HerdR/子进程资源可能未释放。 |
| 直接把 stdout append 到文件 | 当前 daemon 可无限重连/记录诊断，磁盘没有上限。 |
| 日志 supervisor / rotation daemon / 多文件环形日志 | 当前只需有界诊断；单文件按整条截断已满足大小与保留要求，无需新进程或读日志工具。 |
| 保存二进制 build-id，自动重启旧实例 | 当前要求显式 disable/stop/build/enable/start，不需要持久版本状态或自动更新协调。 |

## 发布与回滚

三个串行切片完成 targeted checks 后统一 `bun run check`，再由主会话安排一个独立 full review，必要时最多一次 focused follow-up。规划阶段不运行 app tests，不生成实现/通过证据。

发布前验证控制停止后可复用同一 session 启动；更新演练用隔离测试 bundle，不能在真实 daemon 仍运行时覆盖其 dist。回滚时先 disable，再用当前支持 stop 的 bundle 关闭后台 daemon，确认端点关闭，然后还原本 change 的新增文件/差异、构建、enable；还原到 pane 版前不能留下后台实例。保留本次之前的 dirty Windows/目录模式工作，不使用 reset/clean。

## 未决技术风险

- Bun detached/window 隐藏的真实行为仍需 Windows 与 POSIX 实机验证；当前宿主仅 Windows。Linux/macOS 检查若缺席标记 `NOT RUN`，不能宣称平台已验证。
- Windows owner 检查与 Bun 连接使用不同 handle，存在既有 TOCTOU，同账号伪造者可模拟 daemon。增加实例条件比较防误停正常重启，不升级为身份认证协议；不削弱现有 SID/DACL/pipe 检查。
- ACK flush/close、内外 scope 清理顺序、控制端点关闭到实际进程退出的极短间隙，必须用真实 built process 证据确认；仅有 mock ACK 不足以证明 stop。
- 1,500 ms deadline 沿用现有契约。冷启动若在受支持机器上持续超时，返回主会话确认要求后再调整，不能私自引入重试 supervisor 或扩展 deadline。
- 有界同步日志每次最多写 16 KiB；测试大量记录后文件仍不超过 1 MiB、日志失败能结束 daemon。若性能不足再报告证据，不先建设队列架构。
- 现有版本不认识 stop，因此第一次从 pane 版迁移需要原前台 daemon 正常退出；后续更新走统一 stop 顺序。

## 验收追溯

spec 未提供 AC 编号；下列别名仅是追溯键，精确需求标题与正文仍由原 spec 拥有。`tasks.md` 各上下文包内联相应验收原文与场景。

| 追溯键 / spec Requirement | 设计 | 实施切片 / 测试接缝 |
| --- | --- | --- |
| `hooks` / Hooks start one detached hidden daemon | D1、D2 | T2：hook/start 争用与 real-process 存活；T3：manifest 无 pane |
| `environment` / Background daemon inherits the invoking session configuration | D2、D5 | T2：spawn argv/env；T3：Zed 路径/目录模式 E2E |
| `readiness` / Hook startup is bounded by a readiness deadline | D1、D2、D5 | T2：clock/注入失败与锁清理 |
| `start` / Explicit start is idempotent | D1、D2 | T2：CLI + 同时 hook/start；T3：enable 后重复 start |
| `stop` / Stop shuts down through owner-validated control | D3、D4 | T1：协议、CLI、scope 与 built daemon stop |
| `health` / Health reports background daemons | D2、D6 | T2：真实后台 paneId null 与 no-start；T1/T3：集成回归 |
| `update` / Plugin update keeps exactly one current daemon | D6 | T3：操作步骤与 build 前后实例验证 |
| `logging` / Detached daemon logging is bounded on disk | D5 | T2：容量/权限/启动失败；T3：真实后台记录 |
| `posix` / POSIX detached startup is preserved | D1—D5 | T2：spawn contract；T3：Linux/macOS 实际父进程退出与控制 stop |
