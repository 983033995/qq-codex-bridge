# vNext Progress

## Snapshot

- Updated: 2026-08-10
- Branch / Worktree: `codex/vnext` / `/Volumes/13759427003/AI/qq-codex-bridge-vnext`
- Current milestone: M3 — 管理 API 与管理台
- Overall status: on_track

## Completed

- [x] M0-01 — 从原仓库 `HEAD` `52839e76ddef083fd9af314207e5576998801b76` 创建独立 sibling worktree，复制并核对三份 vNext 权威文档；文档基线 Commit `5305b9d`。
- [x] M0-02 — 建立本进度台账。
- [x] M0-03 — 捕获环境、CodeGraph、Codex 可发现性以及 `check/test/build` 工程基线；旧测试基线为 5 个 AppServer Fake 时序超时。
- [x] M0-04 — 建立 `docs/decisions/vnext/`。
- [x] M0 Gate — 通过；报告见 `docs/reports/vnext/M0-GATE.md`。
- [x] M1-01 — 建立 4 个 vNext App 与 10 个 Adapter/Application/Infrastructure 包的最小入口；现有 `domain`/`ports` 目录保留并将在后续任务内增量替换语义。
- [x] M1-02 — 在 `packages/domain/src/vnext/` 实现 Channel/Space ID、核心聚合类型、Turn/Delivery 状态机、Binding 不变量和稳定错误分类；不修改 v0.x 高影响 Symbol。
- [x] M1-03 — 在 `packages/ports/src/vnext/` 实现 Channel、Codex、Router、Config、Secret、Service、Repository 与基础设施 Ports，并建立可复用 Fake Contract Suite；Router 输入不暴露原始 `spaceId`。
- [x] M1-04 — 实现严格 `config.json` Schema、SHA-256 Revision、0600 原子写入、Apply Planner、失败回滚、内存 Secret Store 与 macOS Keychain Adapter；Keychain 写入值通过 stdin 传递且不进入 argv。
- [x] M1-05 — 实现独立 `runtime-vnext.db` Schema、WAL/Foreign Key/Busy Timeout、IMMEDIATE Migration Runner、核心运行表、Binding 数据库不变量、游标分页与全部 Repository；覆盖持久化恢复、幂等、约束分类及事务/Migration 回滚。
- [x] M1-06 — 实现 `ReceiveInboundMessage`、`BindConversationSpace`、`StartConversationTurn`、`ExecuteControlAction`、`ApplyConfiguration`、`RunHealthCheck`、`EnqueuePush`；默认独占新线程、同线程串行/不同线程并行，三类高风险动作未确认时零副作用。
- [x] M1-07 — 使用真实 SQLite Adapter + Fake Codex 完成 A/B/C 系统验收：微信/飞书/QQ Space 独立绑定，不同线程并行、同线程严格串行，Store 重启后 Binding 恢复，独占冲突明确失败并回滚原 Binding。
- [x] M1 Gate — 通过；Domain 边界、Ports Contract、失败路径与 Fake A/B/C 验收完成，最终 `check/test/build` 全绿；报告见 `docs/reports/vnext/M1-GATE.md`。
- [x] M2-01 — 建立可复用 Fake AppServer：监听器注册后异步 `open`，支持 JSON-RPC Request/Response、Notification、乱序、重复、断线、丢请求超时，以及 Thread Start/List/Rename/Fork 和 Turn Start/Delta/Complete/Interrupt；旧 driver 测试已统一复用。
- [x] M2-02 — 实现独立 vNext `CodexAppServerAdapter`：安全的本地进程发现与受管启动、JSON-RPC Request Map、`threadId + turnId` Pending Map、Thread/Turn 路由、增量/最终文本与媒体归一化、断线拒绝且不重发已接受 Turn、自动重连、Dispose 清理、Capability/Health，并通过真实 `CodexPort` Contract。
- [x] M2-03 — 实现 `ThreadCoordinator` 并接入 Binding/Control 用例：新 Space 默认独占真实 Thread ID，支持 Active/共享/独占 Binding、创建/切换/重命名/分叉/解绑、标题缓存刷新、冲突前置检查与替换回滚；AppServer Thread 消失时将旧 Binding 标记 `broken` 并重建。
- [x] M2-04 — 以有界 `ThreadScheduler` 替换无界 Promise Tail：同 Space 与同 Thread 均严格 FIFO，不同 Thread 默认最多并行 3；实现 Space 接收序号校验、Thread/全局队列上限、持久化排队事件、队列取消、运行中断和失败释放；新增显式 `unknown` Turn 状态、SQLite v2 无损 Migration，并通过稳定 `thread/read(includeTurns)` 对遗留 Turn 做 AppServer 状态对账。
- [x] M2-05 — 实现独立 `CodexRecoveryPort`、`CdpRecoveryAdapter` 和 `CodexTransportCoordinator`：仅支持已知线程选择、纯文本单次提交、最终回复与基本状态；Recovery 全局互斥且始终报告 `degraded`，只在 AppServer 明确 `accepted: false` 时进入，UI 点击后必须再次确认提交且绝不自动重发；Turn 持久化记录真实 transport。
- [x] M2-06 — 实现并运行真实 Codex Smoke：安全跳过 cwd 已失效的陈旧 AppServer、等待受管 listener 就绪；创建 A/B/C 三线程并行回收唯一 marker，使用隔离 readiness probe 验证真实运行中断，并仅在通知或状态确认 `interrupted` 后成功。最终 run `m2-06-20260810-2035` 通过，测试线程保留并列入 M2 Gate 报告。
- [x] M2 Gate — Fake 时序、A/B/C 并发与同线程 FIFO、断线无重提、Recovery 限制和真实 Codex Smoke 均通过；报告见 `docs/reports/vnext/M2-GATE.md`。
- [x] M3-01 — 实现 Control Daemon Composition Root、动态 Health Registry 与有界 Structured Event Bus：组件按序启动/失败回滚、逆序停止、串行生命周期、hot reload/组件重启/全组件重启、Active Revision、结构化状态事件和 SIGINT/SIGTERM 单次优雅退出；Bootstrap 不内联 Use Case。
- [x] M3-02 — 实现完整 `/api/v1` 管理 API 路由契约：System/Health、Channels、Spaces/Messages/Bindings、Threads/Turns、Router、Config Plan/Apply、Diagnostics 和 Push Targets；仅允许 Loopback Bind/Client/Host，使用有界本地 Session、CSRF、严格 Zod/JSON 校验、1 MiB Body 上限、稳定错误响应与内部错误脱敏。

## In Progress

- [ ] M3-03 — 实现支持断线重连与 Last-Event-ID 的 SSE。

## Next

- [ ] M3-04 — 实现管理台 Shell、路由和 API Client。

## Verification

| Command / Check | Result | Date |
|---|---|---|
| `git worktree add -b codex/vnext ... 52839e7` | PASS；新 worktree 创建成功 | 2026-08-10 |
| 原工作区 `git status --porcelain=v1` | 57 项；SHA-256 `55b004726404ce5b08d61ced56c56294439e4a4721e3c5b1b2ec5d21c89b5649` | 2026-08-10 |
| 原工作区 `codegraph status` | PASS；155 files / 2,665 nodes / 7,360 edges，索引最新 | 2026-08-10 |
| 新 worktree `codegraph status` | PASS；155 files / 2,611 nodes / 7,127 edges，索引最新 | 2026-08-10 |
| `pnpm install --frozen-lockfile` | PASS；212 个包，lockfile 未修改 | 2026-08-10 |
| `pnpm check` | PASS | 2026-08-10 |
| `pnpm build` | PASS | 2026-08-10 |
| `pnpm test` | BASELINE FAIL；50/51 test files、247/252 tests 通过；5 个 AppServer Fake 时序超时 | 2026-08-10 |
| Codex/AppServer 可发现性 | PASS；CLI `0.147.0-alpha.6.5`，默认 binary 存在且运行中进程可见 | 2026-08-10 |
| M1-01 `pnpm check` | PASS | 2026-08-10 |
| M1-01 `pnpm build` | PASS | 2026-08-10 |
| M1-02 `vitest`（vNext + legacy domain） | PASS；2 files / 17 tests | 2026-08-10 |
| M1-02 `pnpm check` | PASS | 2026-08-10 |
| M1-02 `pnpm build` | PASS | 2026-08-10 |
| M1-03 Port Contract | PASS；1 file / 5 tests | 2026-08-10 |
| M1-03 vNext 回归 | PASS；2 files / 19 tests | 2026-08-10 |
| M1-03 `pnpm check` | PASS | 2026-08-10 |
| M1-03 `pnpm build` | PASS | 2026-08-10 |
| M1-04 Config/Keychain Unit + Contract | PASS；4 files / 31 vNext regression tests | 2026-08-10 |
| M1-04 `pnpm check` | PASS | 2026-08-10 |
| M1-04 `pnpm build` | PASS | 2026-08-10 |
| M1-05 SQLite Repository Contract + Failure Paths | PASS；2 files / 14 tests | 2026-08-10 |
| M1-05 vNext 回归 | PASS；6 files / 45 tests | 2026-08-10 |
| M1-05 `pnpm check` | PASS | 2026-08-10 |
| M1-05 `pnpm build` | PASS | 2026-08-10 |
| M1-06 Application Use Cases | PASS；3 files / 18 tests | 2026-08-10 |
| M1-06 vNext 回归 | PASS；9 files / 63 tests | 2026-08-10 |
| M1-06 `pnpm check` | PASS | 2026-08-10 |
| M1-06 `pnpm build` | PASS | 2026-08-10 |
| M1-07 Fake A/B/C Integration | PASS；1 file / 2 tests | 2026-08-10 |
| M1-07 `pnpm check` | PASS | 2026-08-10 |
| M1-07 `pnpm build` | PASS | 2026-08-10 |
| M1 Gate Fake AppServer Regression | PASS；1 file / 8 tests；原 5 个超时已消除 | 2026-08-10 |
| M1 Gate `pnpm check` | PASS | 2026-08-10 |
| M1 Gate `pnpm test` | PASS；61 files / 319 tests | 2026-08-10 |
| M1 Gate `pnpm build` | PASS | 2026-08-10 |
| M1 Gate 原工作区保护复核 | PASS；57 项；SHA-256 `55b004726404ce5b08d61ced56c56294439e4a4721e3c5b1b2ec5d21c89b5649` | 2026-08-10 |
| M2-01 Fake AppServer + Legacy Driver | PASS；2 files / 11 tests | 2026-08-10 |
| M2-01 `pnpm check` | PASS | 2026-08-10 |
| M2-01 `pnpm test` | PASS；62 files / 322 tests | 2026-08-10 |
| M2-01 `pnpm build` | PASS | 2026-08-10 |
| M2-02 AppServer Unit + Contract + Fake | PASS；3 files / 14 tests | 2026-08-10 |
| M2-02 `pnpm check` | PASS | 2026-08-10 |
| M2-02 `pnpm test` | PASS；64 files / 333 tests | 2026-08-10 |
| M2-02 `pnpm build` | PASS | 2026-08-10 |
| M2-03 Coordinator + Application + AppServer Regression | PASS；4 files / 29 tests | 2026-08-10 |
| M2-03 vNext Binding Integration | PASS；4 files / 21 tests | 2026-08-10 |
| M2-03 `pnpm check` | PASS | 2026-08-10 |
| M2-03 `pnpm test` | PASS；65 files / 340 tests | 2026-08-10 |
| M2-03 `pnpm build` | PASS | 2026-08-10 |
| M2-04 OpenAI Docs + 本机 AppServer Schema | PASS；稳定 `thread/read` 支持 `includeTurns`，本机 CLI `0.147.0-alpha.6.5` Turn 状态 Schema 已核对 | 2026-08-10 |
| M2-04 Scheduler/Application 精确回归 | PASS；4 files / 24 tests | 2026-08-10 |
| M2-04 vNext Unit/Contract/Integration | PASS；14 files / 95 tests | 2026-08-10 |
| M2-04 `pnpm check` | PASS | 2026-08-10 |
| M2-04 `pnpm test` | PASS；66 files / 351 tests | 2026-08-10 |
| M2-04 `pnpm build` | PASS | 2026-08-10 |
| M2-04 `git diff --check` | PASS | 2026-08-10 |
| M2-04 CodeGraph 同步与影响复核 | PASS；222 files / 3,838 nodes / 11,137 edges，索引最新；无 HIGH/CRITICAL 调用面 | 2026-08-10 |
| M2-04 原工作区保护复核 | PASS；57 项；SHA-256 `55b004726404ce5b08d61ced56c56294439e4a4721e3c5b1b2ec5d21c89b5649` | 2026-08-10 |
| M2-05 Recovery/Coordinator/Legacy Driver 精确回归 | PASS；5 files / 65 tests | 2026-08-10 |
| M2-05 vNext Unit/Contract/Integration | PASS；17 files / 108 tests | 2026-08-10 |
| M2-05 `pnpm check` | PASS | 2026-08-10 |
| M2-05 `pnpm test` | PASS；69 files / 365 tests | 2026-08-10 |
| M2-05 `pnpm build` | PASS | 2026-08-10 |
| M2-05 `git diff --check` | PASS | 2026-08-10 |
| M2-05 CodeGraph 同步与影响复核 | PASS；228 files / 3,990 nodes / 11,608 edges，索引最新；Recovery 未扩展为完整 `CodexPort` | 2026-08-10 |
| M2-05 原工作区保护复核 | PASS；57 项；SHA-256 `55b004726404ce5b08d61ced56c56294439e4a4721e3c5b1b2ec5d21c89b5649` | 2026-08-10 |
| M2-06 AppServer/Smoke 精确回归 | PASS；3 files / 16 tests | 2026-08-10 |
| M2-06 真实 Codex Smoke | PASS；run `m2-06-20260810-2035`；3 个独立 Thread/Turn marker 对应，中断 Turn 状态 `interrupted`，测试 Thread 全部保留 | 2026-08-10 |
| M2 Gate vNext Unit/Contract/Integration | PASS；18 files / 112 tests | 2026-08-10 |
| M2 Gate `pnpm check` | PASS | 2026-08-10 |
| M2 Gate `pnpm test` | PASS；70 files / 369 tests | 2026-08-10 |
| M2 Gate `pnpm build` | PASS | 2026-08-10 |
| M2 Gate `git diff --check` | PASS | 2026-08-10 |
| M2 Gate CodeGraph 同步与影响复核 | PASS；231 files / 4,057 nodes / 11,789 edges，索引最新；改动调用面均由对应 vNext Unit/Contract/Integration 覆盖 | 2026-08-10 |
| M2 Gate 原工作区保护复核 | PASS；仍为 57 项；NUL 分隔 `git status --porcelain=v1 -z` SHA-256 仍为 `55b004726404ce5b08d61ced56c56294439e4a4721e3c5b1b2ec5d21c89b5649` | 2026-08-10 |
| M3-01 Composition Root / Observability 精确回归 | PASS；3 files / 22 tests | 2026-08-10 |
| M3-01 vNext Unit/Contract/Integration | PASS；19 files / 117 tests | 2026-08-10 |
| M3-01 `pnpm check` | PASS | 2026-08-10 |
| M3-01 `pnpm build` | PASS | 2026-08-10 |
| M3-01 `git diff --check` | PASS | 2026-08-10 |
| M3-02 Control API + Config 精确回归 | PASS；2 files / 18 tests | 2026-08-10 |
| M3-02 `pnpm check` | PASS | 2026-08-10 |
| M3-02 `pnpm test` | PASS；72 files / 380 tests | 2026-08-10 |
| M3-02 `pnpm build` | PASS | 2026-08-10 |
| M3-02 `git diff --check` | PASS | 2026-08-10 |
| M3-02 CodeGraph 影响复核 | PASS；新增管理 API 调用面由 Contract 覆盖，配置 Schema 由 Unit/Contract 覆盖，无 HIGH/CRITICAL 调用面 | 2026-08-10 |
| M3-02 原工作区保护复核 | PASS；仍为 57 项；NUL 分隔 `git status --porcelain=v1 -z` SHA-256 仍为 `55b004726404ce5b08d61ced56c56294439e4a4721e3c5b1b2ec5d21c89b5649` | 2026-08-10 |

## Risks and Blockers

| ID | Impact | Mitigation | Owner |
|---|---|---|---|
| R-M0-01 原工作区含 57 项用户修改 | 极高：误操作会覆盖用户工作 | 所有业务开发只在 sibling worktree；每次 M0 关键写操作后复核状态指纹 | Codex |
| R-M0-02 v0.x AppServer Fake 有 5 个时序超时 | 已关闭：全量测试恢复绿色 | Fake 仅在连接创建后异步触发 `open`；精确 8/8、全量 319/319 通过 | Codex |
| R-M2-01 AppServer WebSocket 传输仍由官方标记为实验性 | 中：协议或传输行为变化可能影响主链路 | 固定 loopback、Capability/Health、版本精确 Schema 核对、Fake 故障矩阵与 CDP 提交前 Recovery；不把已接受 Turn 自动重发 | Codex |
| R-M2-02 AppServer 中断 RPC 与真实 Turn 状态存在竞态 | 已关闭：RPC 成功或 `no active turn` 都不再被当作充分证据 | 仅以 `turn/completed(interrupted)` 或 `thread/read` 的 `interrupted` 确认成功；真实 readiness probe 与“RPC 成功但 Turn 完成”反例已锁定 | Codex |
| R-EXT-01 真实渠道、Router 与 Apple 凭据尚未提供 | 后续真实 E2E、24 小时 Gate、签名发布将阻塞 | 先完成全部 Fake/Contract/Integration、本地安装和无需凭据的工作，届时集中请求最小输入 | User |

## Decisions

| ADR / Decision | Reason |
|---|---|
| 以 `52839e76ddef083fd9af314207e5576998801b76` 创建 `codex/vnext` | 避免把原始脏工作区的任何非 vNext 修改带入新分支 |
| 新 worktree 使用 `/Volumes/13759427003/AI/qq-codex-bridge-vnext` | 计划推荐路径不存在，满足 sibling 隔离要求 |
| 代码理解和现有 Symbol 影响分析仅使用 CodeGraph | 用户明确要求后续不再使用 GitNexus；新 worktree CodeGraph 已初始化且索引最新 |
| 遗留 Turn 使用稳定 `thread/read(includeTurns)` 对账 | 官方 OpenAI Docs 与本机生成 Schema 均确认可按真实 Thread ID 读取完整 Turn 历史；避免依赖实验性 `thread/turns/list` |
| CDP Recovery 仅按唯一精确缓存标题操作桌面 UI | AppServer 的真实 `threadId` 仍是持久化身份；桌面 UI 不暴露可靠 ID 时，标题无匹配或重复均明确失败，避免猜测导致跨线程错投递 |
| `turn/interrupt` 必须以真实终态确认 | 本机 AppServer 存在 RPC 成功但 Turn 继续完成，以及实际已中断但 RPC 返回 `no active turn` 两种竞态；请求响应本身不能代表业务终态 |
