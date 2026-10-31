# 交付验证

## 状态

2026-10-31：交付状态 `complete`，T1/T2/T3 done，`awaiting-acceptance`。实现和 Windows 验证完成，真实隔离更新演练已通过；full review 的 F1 已修复并通过唯一 focused review，最终 `CLEAN`。未提交、未推送、未归档，未代替用户验收。Linux/macOS 没有可用运行环境，保持 `NOT RUN`，不推断跨平台通过。

## 需求覆盖

| Requirement                                                   | 状态           | 证据或缺口                                                                                                                                                     |
| ------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hooks start one detached hidden daemon                        | PASS (Windows) | built E2E 混合 hook/start 并发、父进程退出后 health 和编辑器调用；真实更新前后只有原有 w1:p1，无 daemon pane。POSIX NOT RUN。                                  |
| Background daemon inherits the invoking session configuration | PASS (Windows) | spawn argv/env 单测；built E2E 自定义 endpoint、Zed 和项目模式；真实独立配置/socket 的 daemon 协商到 protocol 22，paneId null。                                |
| Hook startup is bounded by a readiness deadline               | PASS           | hook-unit 总截止时间、失败不通知、清理锁、重试测试；首写失败 built daemon exit 1 且 health 不可达。                                                            |
| Explicit start is idempotent                                  | PASS           | built E2E 与真实 HerdR 更新演练都断言重复 start 的 pid/startedAt 不变。                                                                                        |
| Stop shuts down through owner-validated control               | PASS (Windows) | T1 控制与 built 证据见 t1-evidence.md；本轮 full check 重跑，stop 后端点/订阅关闭和正常退出。POSIX 专用安全测试 NOT RUN。                                      |
| Health reports background daemons                             | PASS           | detached health 的 paneId null，stop 后 health exit 1；health 不启动实例。                                                                                     |
| Plugin update keeps exactly one current daemon                | PASS (Windows) | 隔离 bundle built E2E 与真实 HerdR disable/stop/build/enable/start/health 演练；新 startedAt 晚于 build，实例更替且重复 start 不变。                           |
| Detached daemon logging is bounded on disk                    | PASS           | 每文件 1,048,576 bytes、零备份、每记录最多 16,384 bytes；同步写入回归、轮转/权限/失败测试、后台运行日志和启动/运行时写入失败 E2E。POSIX 文件安全测试 NOT RUN。 |
| POSIX detached startup is preserved                           | NOT RUN        | 无 Linux/macOS 主机或 WSL 发行版；公共 detached argv 的测试不能代替实机存活证明。                                                                              |

## 本轮修正与 RED/GREEN

- `src/plugin/daemon-log.ts` 删除无限 Promise tail，改为每条最多 16 KiB 的同步完整写入。轮转在同一已校验 fd 上 truncate 并从 offset 0 写入，删除 Windows 按路径重开再 truncate 的分支。首次失败锁存并只通知一次；后续写不重试，关闭不再等待无界 backlog。
- 日志回归先 RED：写入方法返回后立即读取文件，旧实现为空；修复后 GREEN。
- `src/app.ts` 在绑定 control endpoint 前写入 `daemon_started`。built startup 日志断言先 RED：旧实现的 preflight 之后直接出现 `herdr_disconnected`；修复后第二条是正确 pid 的 `daemon_started`。
- 故障注入只在测试 preload 中替换 `node:fs.writeSync`，没有增加生产配置。首写失败 E2E 验证 exit 1、空日志、health exit 1；运行中失败 E2E 的旧 `Effect.race` 因成功优先语义等待不退出而 RED，改用 `Effect.raceFirst` 后 GREEN：exit 1、指定 HerdR subscription 关闭、health exit 1。
- `test/e2e/daemon.test.ts` 让实际调用读取 `process.env` 的 `ZED_HERDR_TEST_DIST`，修复先前只有 helper 测试读取 override、正常 E2E 忽略 override 的问题。
- 原先启动、manifest 等初始实现的 RED 没有完整保存，本轮不补造历史。上述三项缺陷有实际 RED/GREEN；全部现有契约随 full check 重新执行。

## 执行结果

环境：Windows、Bun 1.4.4 (38afee6c8)、HerdR 0.9.5 / protocol 22。

- 首轮 `bun run check`（F1 复验前）：PASS，完整 exit 0；typecheck、lint、build 均通过，`161 pass / 17 skip / 0 fail`，778 expect，15 files，73.56 s。17 skip 是 15 项 POSIX 专用测试和 2 项需要显式开启的 live HerdR 测试。此结果替代上一轮被外部 60 秒上限终止的未完成 check；最终材料结果见“复验轮次 1”。
- `bun test test/plugin/daemon-log.test.ts`：11 pass / 2 skip / 0 fail，99 expect。
- 两项新增 built 日志故障 E2E：2 pass / 0 fail，9 expect；完整 check 已再次覆盖它们及原有 S1/ack/S2、directory、stop/update 场景。
- 隔离真实 HerdR 内的 `ZED_HERDR_TEST_LIVE=1 bun test test/herdr/windows-transport.test.ts`：PASS，9 pass / 0 fail，24 expect，包含原先两项 opt-in 的 live snapshot/subscription 测试。
- Linux/macOS targeted E2E：`NOT RUN`。`wsl --list --quiet` 未发现发行版。
- 回滚：仅有任务中的操作方案，未执行撤回实现的演练。

## 真实 HerdR 更新演练

原始结果：`real-herdr-evidence.json`。使用临时源代码副本、冻结依赖安装和独立 `HERDR_CONFIG_PATH`、`APPDATA`、`LOCALAPPDATA`、`HOME`、`USERPROFILE`、`XDG_CONFIG_HOME`、`HERDR_SOCKET_PATH`，先确认该注册目录没有任何插件。启动自己的 `herdr server`，不改变用户默认服务器、会话或插件注册。`ZED_BIN` 指向隔离目录内不存在的路径，不调用用户的编辑器。

1. `bun install --frozen-lockfile`、`bun run build`；`herdr plugin link <isolated-plugin> --disabled`、enable、built start。
2. 依次执行 disable → built stop → health（exit 1）→ build → enable → built start。任一步失败都不执行后续 build/start。
3. 旧 pid 24096，startedAt `2026-10-31T04:42:14.899Z`；build 完成 `2026-10-31T04:42:15.828Z`（1793421735828）；新 pid 10780，startedAt `2026-10-31T04:42:16.307Z`。health 协议为 22，paneId null，重复 start 的 pid/startedAt 不变。
4. 更新前后 pane ids 都是 `[w1:p1]`，没有创建 daemon pane。最后 built stop、plugin disable、`herdr server stop`，删除自己的临时目录。

HerdR 0.9.5 的实际 `plugin link` 解析要求路径在 `--disabled` 前；首次参数顺序不兼容的隔离尝试失败并清理后，按上述顺序重跑通过。这不影响 README 使用的无 flag `herdr plugin link <repo>`。

## 独立复核

`review-implementation` / `workflow-reviewer`，fresh context，`Review mode: full`，base `60513f36508cc84005badbd0031826f0a61d1f2d`。范围包含该 change 的相关 unstaged / untracked 生产文件、测试、manifest 与文档，并阅读相邻安全和同步代码。full round 1 为 `FINDINGS`：F1（MEDIUM / blocking）发现 Windows pipe 预检查未计入 stop 总 deadline，5,000 ms 预算实测 5,102 ms。完整结论见 `review-full.md`。

## 复验轮次 1

- 修复范围限于 F1 的共享 `requestControl` 和对应控制边界回归。
- 回归 `includes occupied-pipe prechecks in the stop deadline and never writes after expiry`：独立子进程 mock 平台/传输/时钟，health 消耗 4,950 ms、stop 遇 occupied；旧实现错误 resolve（RED），修复后 timeout，clock 恰好 5,000 ms，仅一个 health 连接/请求，没有 stop 写入（GREEN）。
- `bun test test/plugin/control-socket.test.ts -t 'includes occupied-pipe'`：1 pass / 0 fail。`bun run typecheck` PASS；随后执行完整检查。
- 首次修复后 full check：161 pass / 17 skip / 1 fail。失败为 `documents that a listening same-account squatter receives hints and can forge responses`：fixture 只 write、不结束回复，原实现竟在超时 terminate 触发的 close 中把完整帧当成功。严格 deadline 后不再接受这种超时回复；fixture 改为与控制协议一致的 end 完整回复，仍验证同账号冒充风险。超时处理同时先锁定失败再 terminate，避免同步 close 回调重入。
- 修正 fixture 后 `bun test test/plugin/control-socket.test.ts test/plugin/windows-security.test.ts`：27 pass / 9 skip / 0 fail，88 expect。
- 最终 `bun run check`：完整 exit 0，typecheck/lint/build PASS；162 pass / 17 skip / 0 fail，780 expect，15 files，57.12 s。覆盖 F1 修复及修正后的 fixture，替代本轮前一次失败。
- focused round 1：`CLEAN`，F1 `RESOLVED`，无剩余 blocking finding，报告见 `review-focused.md`。同一独立 reviewer context 复跑两套测试，独立确认约 5,001 ms 的实时 timeout 和无 stop 写入，以及慢预检查/迟到连接/超时 close 的隔离探针。未执行第二次 full review，预算完整保留为一次 full + 一次 focused。

## 提交与验收

- 提交：`NOT COMMITTED`，未推送、未归档；保留原有无关工作树修改。
- 验收：待用户验收，任务阶段 `awaiting-acceptance`。
- Windows 复验入口：`bun run check` 覆盖上表前八项 Requirement 的自动化契约；live transport 需在隔离 HerdR 中显式 `ZED_HERDR_TEST_LIVE=1 bun test test/herdr/windows-transport.test.ts`。
- 真实更新验收：在独立配置/服务器中依次执行 README 的 disable → stop → build → enable → start → health，比较 build/startedAt、重复 start 身份及 pane 数；逐步证据见上文和 `real-herdr-evidence.json`。
- POSIX Requirement 的实机验收：Linux/macOS 上 build 后执行 `bun test test/plugin/hook-unit.test.ts test/e2e/daemon.test.ts`，确认父进程退出后的 daemon 存活。当前无主机或 WSL 发行版，`NOT RUN`。

## 剩余风险与历史缺口

- Linux/macOS 的 detached 存活和 POSIX 专用安全测试尚未实机执行；具备对应主机后必须补跑，不以 Windows PASS 代替。
- 原始初始实现的部分 RED 为 `NOT CAPTURED`；本轮三项日志修复及 F1 有实际 RED/GREEN。
- 回滚演练 `NOT RUN`；只保留任务中的操作方案，未为收尾而撤回实现。
