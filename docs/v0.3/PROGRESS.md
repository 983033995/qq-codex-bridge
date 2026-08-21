# v0.3 当前进度与验收记录

更新时间：2026-08-13  
分支：`codex/v0.3-ai-control-center`

本文只记录当前工作区的 v0.3 实现状态；不把旧 `codex/vnext` worktree 的 `docs/VNEXT-PROGRESS.md` 当作本分支验收依据。

## 已完成

| 范围 | 状态 | 证据 |
| --- | --- | --- |
| 来源身份、Conversation Alias、Active Conversation、Reply Routing | 已实现 | `packages/application/src/conversation-resolver.ts`、`packages/application/src/route-inbound-message.ts`、SQLite source-routing migration |
| AppServer Approval 闭环 | 已实现 | AppServer capture → SQLite → 渠道/Admin/MCP resolve → AppServer 回写；管理台 Task 页面显示待审批请求 |
| 多渠道统一入站/出站 Runtime | 已实现 | 微信、飞书、QQ 共用 `WeixinMessageRuntime` 的持久化 Delivery 流程 |
| Transport Isolation | 已实现 | 单 Session CDP fallback 不再修改全局 AppServer 首选传输；已有跨 Session 回归测试 |
| Durable Turn Ledger | 已实现 | `starting/running/unknown/completed` 状态持久化；完成结果写入 `turns.result_json` checkpoint |
| Delivery Checkpoint | 已实现 | 内容先落 SQLite，再发送；稳定 `deliveryKey`、`pending/sending/retry_wait/delivered/failed` 状态和有界重试 |
| 最终回复崩溃恢复 | 已实现 | 启动扫描已完成 Turn；若最终 Delivery 尚不存在，按同一 key 重建并发送；重复启动不会重复发送 |
| Runtime Turn reconcile | 已实现（非 queued） | 启动顺序为路由迁移 → Turn reconcile → Runtime 启动；AppServer 不可用时保留 `unknown` |

## 当前明确边界

`ThreadScheduler` 的 `queued` 项目前仍是进程内排队项。Codex 只有在真正提交后才返回远端 `turnId`，因此当前不会把没有远端 ID 的 queued 项在重启后盲目重新提交；这避免重复执行，但该进程在崩溃时排队中的消息需要用户重新发送。

后续若要恢复 queued 项，应先为本地排队 ID 与远端 Codex Turn ID 建立独立映射，再增加安全的 queued 恢复策略；本轮不引入这项较大模型变更。

## 本轮验证

| 检查 | 结果 |
| --- | --- |
| `pnpm check` | 通过 |
| `pnpm build` | 通过 |
| 精确 Runtime / SQLite / Scheduler 回归 | 5 个测试文件、38 个测试通过 |
| 崩溃恢复故障注入 | 11 个消息 Runtime 测试通过；覆盖“完成结果已落账、Delivery 尚未创建、重启补发、再次扫描不重复” |
| `git diff --check` | 通过 |
| 全量 `pnpm test` | 98 个测试文件、536 个测试全部通过 |

## 后续任务

1. 为 queued Turn 增加本地排队 ID ↔ 远端 Turn ID 的持久化映射，再决定安全恢复或明确失败通知。
2. 在真实微信、飞书、QQ 凭据和测试会话可用后，执行真实渠道 Gate 与长时间运行验证。
3. 完成发布签名、公证等外部 Gate 后，再形成正式 Release 验收报告。
