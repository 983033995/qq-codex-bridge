# OmniAgent Gateway v0.3 可直接落地的实施计划

本计划用于直接指导 Codex/开发者在 `codex/v0.3-ai-control-center` 分支实施。除非有明确需求变更，不应跳过依赖阶段。

---

# Phase 0 — 基线、命名与回归保护

## 0.1 建立基线测试

目标：保证 v0.2 现有能力在 v0.3 重构期间不被破坏。

任务：

- QQ inbound/outbound smoke test。
- 微信登录与消息链路 smoke test。
- 飞书长连接与消息链路 smoke test。
- AppServer `thread/resume + turn/start + turn/completed` smoke test。
- 现有 Push MCP 工具兼容测试。
- 现有 Router off/assist/auto 与决策记录基线测试。

## 0.2 产品命名迁移基线

产品显示名：`OmniAgent Gateway`。

任务：

- UI 标题/品牌文案不再新增 `QQ Codex Bridge`。
- 新日志前缀、诊断文案、文档统一采用 `OmniAgent Gateway` 或中性 `gateway`。
- 旧仓库/npm/CLI 名作为 compatibility alias 保留。
- 定义旧运行目录 `~/.qq-codex-bridge` 到新目录 `~/.omniagent-gateway` 的迁移策略。
- 不在 Phase 0 直接删除旧 bin。

Phase 0 DoD：

- [ ] 三渠道与 AppServer/MCP/Router 基线测试存在。
- [ ] 新产品名和兼容迁移边界写入测试/文档。

---

# Phase 1 — Runtime Foundation

## 1.1 runtime-manager

建议路径：`packages/runtime-manager/`。

实现：RuntimeStatus / RuntimeDiagnostic / `ensureRunning()` / `start()` / `stop()` / `restart()` / `getStatus()` / `doctor()`。

## 1.2 Runtime 状态目录

新目录目标：

```text
~/.omniagent-gateway/
```

兼容读取：

```text
~/.qq-codex-bridge/
```

文件：runtime.json / runtime.lock / gateway.pid / gateway.log。

任务：原子写、PID 存活校验、stale PID/lock 清理、旧状态迁移。

## 1.3 并发启动锁

10 个并发 `ensureRunning()` 只能启动一个 Runtime。

## 1.4 MCP Bootstrap

MCP 启动时 `ensureRunning()`；MCP 退出不能 stop Runtime。

## 1.5 CLI 收拢

目标 CLI：

```text
omniagent-gateway mcp
omniagent-gateway start
omniagent-gateway stop
omniagent-gateway restart
omniagent-gateway status
omniagent-gateway doctor
omniagent-gateway open
```

兼容：`qq-codex-bridge` / `qq-codex-mcp` 转发到同一实现。

Phase 1 DoD：

- [ ] MCP 自动拉起 Runtime。
- [ ] 多 Host 不重复启动。
- [ ] MCP 退出 Runtime 继续在线。
- [ ] 旧 CLI 仍可工作。

---

# Phase 2 — Config / Secret / Setup

## 2.1 Config Store

schemaVersion / load-save / revision / migration runner / ENV override。

## 2.2 Secret Store

实现 set / exists / replace / delete；禁止 MCP/Control API/Admin 读回明文。

## 2.3 Legacy Migration

迁移旧 `.env`、QQ/飞书 Secret、Channel/Router 配置、运行目录；migration 必须可重复执行。

## 2.4 Setup Domain

`packages/setup/`：SetupSession / SetupState / SetupArtifact / SetupStore / SetupService。

## 2.5 微信 Setup Provider

QR Artifact、状态同步、过期重试、完成后更新 Channel Config。

## 2.6 QQ Setup Provider

AppID / ClientSecret Form Artifact、校验、Secret 写入、Channel 启动、test_channel。

## 2.7 飞书 Setup Provider

同 QQ，并做长连接健康验证。

## 2.8 MCP Setup Tools

get_setup_status / start_setup / submit_setup / get_setup_progress / cancel_setup。

## 2.9 Setup 持久化

Setup Session 写 SQLite，MCP 重启后恢复。

Phase 2 DoD：

- [ ] AI 对话完成微信扫码。
- [ ] AI 对话完成 QQ/飞书配置。
- [ ] Secret 不回显。
- [ ] 老配置平滑迁移。

---

# Phase 3 — Inbound Intelligent Router

这是 v0.3 正式 P0，不允许只保留旧 Router UI 而不重构入站链路。

## 3.1 定义 Router Domain

建议路径：

```text
packages/router/
```

类型：

```text
RouterIntentKind = conversation | control | setup | approval | unknown
RouterDecision
RouterMode = off | assist | auto
RouterRisk = read | low | medium | high
```

验收：类型不依赖具体 LLM Provider。

## 3.2 Inbound Gateway 接入 Router

任务：

- 所有 QQ/微信/飞书 InboundMessage 进入统一 InboundGateway。
- 统一调用 RouterService。
- 禁止 Channel Adapter 直接判断并调用 Codex。
- 保留 correlationId/messageId。

测试：三个渠道同一条语义得到一致 Router 行为。

## 3.3 Deterministic Parser

优先支持：

- `/approve`
- `/decline`
- 现有明确控制命令（如确有兼容需求）

测试：Router Provider offline 时命令仍工作。

## 3.4 Router Provider Adapter

任务：

- 将当前 LLM Router Endpoint 封装成 `RouterProviderPort`。
- schema validation。
- timeout。
- invalid response handling。
- SecretRef。

## 3.5 Intent Dispatcher

实现映射：

```text
conversation -> ConversationService
control      -> Runtime/Channel/Thread Control Service
setup        -> SetupService
approval     -> ApprovalService
unknown      -> Clarification/fallback
```

不得在 Router Service 内直接做业务副作用。

## 3.6 Confidence Policy

默认：high=0.90 / clarify=0.50。

测试：

- 0.95 control → route。
- 0.75 ambiguous setup → clarify。
- 0.30 → conversation fallback。

## 3.7 Risk Policy

对 control/setup/approval action 标风险；高风险动作必须经过对应 Service 的确认/授权策略。

## 3.8 Failure Fallback

测试注入：timeout / HTTP 500 / invalid JSON / invalid schema。

验收：

```text
Router failure
→ 原消息不丢
→ 不执行猜测出的控制动作
→ conversation fallback
→ 记录 degraded/fallback event
```

## 3.9 Router Decision Store

持久化 decisionId/messageId/kind/action/target/confidence/risk/mode/latency/result/fallbackReason。

## 3.10 Router 回归用例

至少覆盖：

- `帮我修订单页` → conversation。
- `重启微信` → control。
- `重新登录微信` → setup。
- `允许刚才的 pnpm test` → approval。
- `把微信那个重新弄一下` → clarify。
- `看看微信代码有什么问题` → conversation fallback。

Phase 3 DoD：

- [ ] 三渠道全部经过 Router。
- [ ] 五类 intent 自动化测试通过。
- [ ] Router 故障不丢消息。
- [ ] control/setup/approval 不误发 Codex。
- [ ] 决策可审计。

---

# Phase 4 — Approval

## 4.1 AppServer 协议分类

response / notification / server request 分开处理。

## 4.2 Approval Domain

`packages/approval/`：ApprovalRequest / ApprovalStore / ApprovalService。

## 4.3 AppServer Approval Bridge

保存 JSON-RPC request id，approve/decline 回 response，serverRequest/resolved 同步状态。

## 4.4 Channel Approval

最低保证：`/approve` / `/decline`；自然语言审批由 Router 识别。

## 4.5 MCP/Admin Approval

MCP resolve_approval；Admin pending query / resolve endpoint / 首页行动项 / Task Detail event。

Phase 4 DoD：Codex 请求 → 渠道通知 → 用户批准 → Codex 继续 → Admin/MCP resolved。

---

# Phase 5 — Runtime Reliability

## 5.1 Transport Isolation

- global preferred = app-server。
- per-session effective transport。
- fallbackReason / fallbackAt。
- recoverOnNextTurn。
- messageAccepted=true 后禁止 CDP 重提。

## 5.2 Durable Turn Ledger

`packages/task-ledger/`，替换关键进程内 checkpoint。

## 5.3 Delivery Checkpoint

text offset / artifact key / delivery success 后推进。

## 5.4 Crash Recovery

Runtime 启动 reconcile queued/running/unknown turn；不盲目 startTurn。

Phase 5 DoD：单 Session fallback 隔离；Runtime 重启不明显重复；final reply 可恢复。

---

# Phase 6 — Control Center UI

UI 最后做。

## 6.1 导航

首页 / 渠道 / 对话 / 任务 / 自动化 / 智能路由 / 系统。

## 6.2 首页

OmniAgent Gateway 品牌、Runtime/Router 状态、running tasks、pending approvals、channels、actionable notices。

## 6.3 Channels

卡片式账号状态；SetupService 连接/重登；test/restart。

## 6.4 Tasks / Task Detail

Task 过滤 + Timeline；Timeline 增加 Router Decision 事件。

## 6.5 MCP

状态、auto bootstrap、last hosts、推荐配置；明确 Claude/OpenCode 本版只通过 MCP 管理/Push，不接收渠道入站 Conversation。

## 6.6 Intelligent Router UI

第一层：

- off / assist / auto
- ready / degraded / offline
- high threshold
- clarify threshold
- low-confidence fallback
- recent decisions

高级设置：Endpoint / Model / SecretRef / timeout。

## 6.7 Runtime / Diagnostics

显示 Gateway Runtime / AppServer / Router Provider / CDP / DB；Router degraded 有人类可读修复建议。

Phase 6 DoD：非开发者能理解首页、Router、Task、Approval；技术细节渐进披露。

---

# Phase 7 — Release Hardening

## 7.1 全链路回归

必须验证：

- QQ → Router → Codex → QQ
- 微信 → Router → Codex → 微信
- 飞书 → Router → Codex → 飞书
- Control intent
- Setup intent
- Approval intent
- Router clarify/fallback
- MCP auto bootstrap/setup/push
- Admin

## 7.2 Upgrade Test

v0.2 → v0.3：Channel/binding/Router config/Secret 不丢，可 rollback，旧 CLI 兼容。

## 7.3 Failure Injection

AppServer 掉线 / CDP unavailable / Channel disconnect / Router provider timeout / Runtime crash / SQLite error / 多 MCP Host 同时启动。

---

# 任务依赖图

```text
Baseline + Branding
       ↓
RuntimeManager
       ↓
MCP Bootstrap
       ↓
Config/Secret/Setup
       ↓
Inbound Intelligent Router
       ↓
Approval
       ↓
Transport Isolation
       ↓
Turn Ledger
       ↓
Control Center UI
       ↓
Release Hardening
```

---

# 推荐提交粒度

```text
chore(brand): introduce OmniAgent Gateway product identity
feat(runtime): add singleton runtime manager
feat(mcp): bootstrap runtime on server startup
feat(config): add versioned config and secret stores
feat(setup): add persistent channel setup protocol
feat(router): route all channel inbound through intent router
feat(router): add deterministic parser and safe fallback
feat(router): persist router decisions
feat(approval): handle app-server server requests
fix(transport): isolate CDP fallback per session
feat(ledger): persist turn delivery checkpoints
feat(ui): add task and router focused control center
```

---

# 每个任务的完成标准

1. 类型检查通过。
2. 新增单测通过。
3. 三渠道回归通过。
4. 不新增未文档化公网监听。
5. 不产生 Secret 明文日志。
6. 不将 CDP 提升主通道。
7. 不绕过 Inbound Router/Application Service。
8. Router 失败不能导致消息丢失。
9. 不新增 `QQ Codex Bridge` 用户可见品牌文案。

---

# M1

最先打通：

```text
用户添加 MCP
  ↓
Runtime 自动 ready
  ↓
AI 配置微信并扫码
  ↓
微信 Channel connected
  ↓
用户微信发“帮我检查当前项目”
  ↓
Inbound Router = Conversation
  ↓
Codex AppServer turn/start
  ↓
回复微信
```

# M2

```text
用户 QQ 发“重启一下微信渠道”
  ↓
Router = Control
  ↓
ChannelControlService
  ↓
微信重启
  ↓
QQ 收到结果
```

在 M1/M2 未打通前，不开始大规模 Admin UI 重构。
