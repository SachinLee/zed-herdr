# Focused 独立复核

- 日期：2026-10-31。
- review_id：`background-daemon-lifecycle-focused-1`。
- 角色：`workflow-reviewer`，独立于实现者的原 reviewer context；agent `01a19042-fdeb-7bf2-8b9b-66333c9bc249`（Turing）。
- 模式：`focused`，预算内唯一一次 follow-up；前序 `review-full.md`。
- 范围：`requestControl` deadline 修复、`control-socket.test.ts` 回归和 `windows-security.test.ts` squatter fixture。全程只读，未修改文件或委派。
- 结论：`REVIEW_STATUS: CLEAN`，F1 `RESOLVED`，无新增 blocking finding。

## F1 与独立验证

- `src/plugin/control.ts:1153` 入口建立 deadline，计时器先于异步预检查。
- `src/plugin/control.ts:1274` readiness 预算为 min(100, remaining)；预检查、owner 检查、连接及写入前均检查到期。
- `src/plugin/control.ts:1169` 先锁定 timeout 失败再 terminate，避免 close 重入接受缓冲响应；迟到连接被终止，不发送请求。
- reviewer 独立实时探针：默认 5,000 ms 预算约 5,001 ms 超时，readiness 获得剩余 46 ms，仅有一次 health 连接/写入，无 stop 连接/写入。1 ms 为调度与计时误差，原额外 100 ms 已消除。
- 独立隔离探针同时确认：缓冲完整响应后超时 close 仍失败；慢预检查超时后不连接；迟到连接终止且不写请求。
- 独立复跑两套受影响测试：27 pass / 9 skip / 0 fail，88 expect。
- scoped git diff --check PASS。

## Standards / Spec

- 本轮无 findings。owner/SID、POSIX inode 复查、fatal UTF-8、64 KiB、单帧、exact response 均保留；错误和 socket 清理路径无相关回归。
- 复用原共享入口，无新增依赖或额外抽象。
- stop 总 deadline 根因闭合，owner、目标实例、完整 ACK 与关闭观察契约保持。
- `test/plugin/windows-security.test.ts:189` 使用 socket.end 完整结束伪造响应合理，仍验证同账号冒充风险，没有放宽生产 framing 或授权。
- 其他 Requirement / scenario 及真实 HerdR 证据沿用 full review，未扩大为第二次 full review。

## 证据覆盖与限制

消费主会话最终 full check：typecheck/lint/build PASS，162 pass / 17 skip / 0 fail；历史失败不作为最终通过证据。最终生产材料由 full review 加本次 focused 覆盖。

reviewer 未重跑 full suite、真实 HerdR 演练、POSIX 实机或回滚验证；这些已有证据和 NOT RUN 记录保持。当前没有剩余 blocking finding。
