# Full 独立复核

- 日期：2026-10-31。
- 角色：`workflow-reviewer`，fresh context；agent `01a19042-fdeb-7bf2-8b9b-66333c9bc249`（Turing）。
- 模式：`full`，第 1 轮；base `60513f36508cc84005badbd0031826f0a61d1f2d`。
- 范围：本 change 的相关 staged / unstaged / untracked 生产文件、测试、manifest、README 和内部文档；相邻平台与同步代码仅用于判断边界，不归为本次新改动。
- 结果：`REVIEW_STATUS: FINDINGS`，一个 blocking finding。以下为 reviewer 回传的结论，由主会话落盘；修复及 focused 结果另记，不覆盖本轮历史。

## F1：Windows pipe 预检查突破 stop 总 deadline

- 严重度：MEDIUM；blocking: yes。
- 原复核位置：`src/plugin/control.ts:1172`、`src/plugin/control.ts:1205`，由 `src/plugin/control.ts:1501` 的剩余预算调用触发；修复后行号可能变化。
- `requestControl` 先做端点检查、最多 100 ms readiness 等待及 owner 验证，再启动请求计时器，预检查未计入传入预算。
- reviewer 独立 Bun 探针只 mock 传输和 pipe 状态：health 约 4,950 ms 返回，stop pipe 暂时 occupied，默认 5,000 ms 总预算实际到 5,102 ms 才失败。输出为 `ControlUnavailable` / `operation: "timeout"` / `elapsed_ms: 5102` / `expected_max_ms: 5000`。可能在总 deadline 后写入 stop。
- 违反 `design.md` D4：5,000 ms 包含 health、stop 两次请求与关闭观察。
- 最小修复要求：入口 deadline 统一覆盖预检查、readiness、连接与响应；到期后不再连接或写入，保留 owner/identity 检查。
- 回归要求：确定性模拟 health 接近截止、stop pipe occupied，断言总预算内失败且未发送 stop；已有 owner、ACK 和关闭等待契约继续通过。

## Standards / Correctness / Security / Tests / Complexity

除 F1 外未发现其他阻断项：

- 复用 Bun、Effect、既有锁及控制协议，没有新增依赖或进程管理体系。
- stop 保留 owner 和 identity/pid/startedAt 条件比较，没有 PID 文件或任意 signal。
- 内层资源先清理、控制端点后关闭；日志失败经 scope 退出，不以 process.exit 绕过 finalizer。
- 后台日志同步有界写入，无无界队列，失败只通知一次，首写先于 control readiness。
- 变更集中于共享入口，无需新增抽象或扩展功能。

## Spec

已逐项审查九个 Requirement、21 个 scenario；“已覆盖”依据实现、断言及主会话执行证据，不表示 reviewer 重跑 full suite。

| Requirement | Scenario 结论                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| hooks       | First hook starts / Concurrent hooks converge / Live daemon reused：已覆盖，共享锁、20 contenders 与混合 hook/start E2E。         |
| environment | Session environment preserved / Pane identity not fabricated：已覆盖，继承配置、清除 HERDR_PANE_ID、paneId null。                 |
| readiness   | Never becomes ready / Becomes ready in time：已覆盖，1,500 ms 预算、取消本次 child、释放自身锁。                                  |
| start       | No daemon / Live daemon：已覆盖，重复调用保持身份。                                                                               |
| stop        | Graceful stop 的 ACK/清理/重启已覆盖，但总 deadline 有 F1；Foreign owner / Never signals arbitrary processes / No daemon 已覆盖。 |
| health      | Background daemon health / Health starts nothing：已覆盖。                                                                        |
| update      | Documented order / Leaves one daemon：已覆盖，真实隔离更新、新实例晚于 build、重复 start 稳定、pane 未增加。                      |
| logging     | Long-running daemon / Destination unavailable：已覆盖，1 MiB、零备份、单条上限、同步可见、初始及运行时失败清理。                  |
| posix       | POSIX background start 的实现与共享契约已审查，Linux/macOS 实机为 NOT RUN；No platform-specific shortcut 的代码检查通过。         |

## 消费的证据与限制

- 主会话 full check：161 pass / 17 skip / 0 fail，typecheck/lint/build PASS。
- live transport：9 pass；真实隔离 HerdR 0.9.5 / protocol 22 更新演练 PASS。
- OpenSpec strict validate 与 git diff --check PASS。
- reviewer 独立执行 F1 deadline 探针，无文件修改或真实服务操作。
- reviewer 未重跑 full suite；Linux/macOS 实机和回滚演练 NOT RUN。
- 需要修复 F1、相关检查，并执行预算内一次 focused review。
