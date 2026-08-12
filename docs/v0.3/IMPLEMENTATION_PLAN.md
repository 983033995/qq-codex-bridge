# v0.3 可直接落地的实施计划

本计划用于直接指导 Codex/开发者在 `codex/v0.3-ai-control-center` 分支实施。除非有明确需求变更，不应跳过依赖阶段。

---

# Phase 0 — 基线与回归保护

## 0.1 建立基线测试

目标：保证 v0.2 现有能力在 v0.3 重构期间不被破坏。

任务：

- 为 QQ inbound/outbound 建 smoke test。
- 为微信登录与消息链路建立 smoke test。
- 为飞书长连接与消息链路建立 smoke test。
- 为 AppServer `thread/resume + turn/start + turn/completed` 建 smoke test。
- 为现有 Push MCP 工具建立兼容测试。

验收：

- 当前三渠道主链路全部有自动化覆盖。
- 后续每个 Phase 完成后必须跑回归。

---

# Phase 1 — Runtime Foundation

## 1.1 新建 runtime-manager package

建议路径：

```text
packages/runtime-manager/
```

任务：

- 定义 RuntimeStatus / RuntimeDiagnostic。
- 实现 `ensureRunning()`。
- 实现 `start()` / `stop()` / `restart()`。
- 实现 `getStatus()` / `doctor()`。

验收：

- 单测覆盖正常启动、已运行复用、停止、重启。

## 1.2 Runtime 状态目录

实现：

```text
~/.qq-codex-bridge/runtime/
```

文件：

- runtime.json
- runtime.lock
- bridge.pid
- bridge.log

任务：

- 原子写 runtime.json。
- PID 存活校验。
- stale PID 清理。
- stale lock 清理。

验收：

- 删除进程但保留 PID 文件后可自动恢复。

## 1.3 并发启动锁

场景：Codex 与 Claude 同时拉起 MCP。

任务：

- lock 获取。
- lock 后二次 health 检查。
- 只有锁持有者执行 spawn。
- 其他调用者等待 ready。

验收：

- 10 个并发 `ensureRunning()` 只启动一个 Bridge。

## 1.4 MCP Bootstrap

任务：

- MCP 启动时调用 `ensureRunning()`。
- Runtime 已存在则复用。
- Runtime 未运行则自动启动。
- MCP 退出不 stop Runtime。

验收：

```text
不手动执行 qq-codex-bridge
→ 启动 MCP Host
→ Bridge 自动 ready
```

## 1.5 CLI 收拢

目标：外部只需要理解一个命令。

推荐：

```text
qq-codex-bridge mcp
qq-codex-bridge start
qq-codex-bridge stop
qq-codex-bridge restart
qq-codex-bridge status
qq-codex-bridge doctor
qq-codex-bridge open
```

现有 bin 可暂时兼容，不必第一阶段立即删除。

Phase 1 DoD：

- [ ] MCP 可以自动拉起 Runtime。
- [ ] 多 Host 不重复启动。
- [ ] MCP 退出 Runtime 继续在线。
- [ ] QQ/微信/飞书回归通过。

---

# Phase 2 — Config / Secret / Setup

## 2.1 Config Store

任务：

- 定义 schemaVersion。
- 实现 config load/save。
- 实现 revision。
- 实现 migration runner。
- ENV 保持 override。

验收：

- 配置可持久化。
- schema 不合法时拒绝 apply。

## 2.2 Secret Store

任务：

- `set(ref, value)`。
- `exists(ref)`。
- `replace(ref, value)`。
- `delete(ref)`。
- 内部 runtime 获取 Secret 的受限接口。

禁止：

- MCP 返回 Secret。
- Control API 返回 Secret。
- Admin 显示 Secret。

测试：

- 所有 API snapshot 中无明文 Secret。

## 2.3 Legacy Migration

任务：

- 检测旧 `.env`。
- 迁移 QQ AppID / Secret。
- 迁移飞书 AppID / Secret。
- 迁移其他普通配置。
- Secret 转 secretRef。
- 迁移失败保留原配置。

验收：

- 老用户无需重配可启动。
- migration 可重复执行。

## 2.4 Setup Domain

新建：

```text
packages/setup/
```

实现：

- SetupSession。
- SetupState。
- SetupArtifact。
- SetupStore。
- SetupService。

状态：

```text
needs_input
waiting_scan
scanned
confirming
applying
connected
failed
cancelled
expired
```

## 2.5 微信 Setup Provider

任务：

- start login。
- 返回 QR Artifact。
- 状态同步。
- expired handling。
- force regenerate。
- 完成后更新 Channel Config。

测试：

- waiting_scan → connected。
- QR 过期后重试。

## 2.6 QQ Setup Provider

任务：

- 定义 AppID / ClientSecret Form Artifact。
- 字段校验。
- Secret 写入。
- Channel 启动。
- test_channel。

错误：

- missing_field
- invalid_app_id
- invalid_secret
- connection_failed

## 2.7 飞书 Setup Provider

同 QQ，增加长连接健康验证。

## 2.8 MCP Setup Tools

实现：

- get_setup_status
- start_setup
- submit_setup
- get_setup_progress
- cancel_setup

要求：

- Tool 输出适合 AI 解释。
- 不返回底层无关字段。

## 2.9 Setup 持久化

任务：

- Setup Session 写 SQLite。
- MCP 重启后可恢复。
- expired 自动标记。

Phase 2 DoD：

- [ ] AI 对话中可完成微信扫码。
- [ ] AI 对话中可完成 QQ 配置。
- [ ] AI 对话中可完成飞书配置。
- [ ] Secret 不回显。
- [ ] 老配置平滑迁移。

---

# Phase 3 — Approval

## 3.1 AppServer 协议分类

修改 AppServer adapter：

- response
- notification
- server request

三类分开处理。

测试 server request 不得进入 notification 路径。

## 3.2 Approval Domain

新建：

```text
packages/approval/
```

实现：

- ApprovalRequest
- ApprovalStore
- ApprovalService

类型：

- command_execution
- file_change

## 3.3 AppServer Approval bridge

任务：

- 保存 JSON-RPC request id。
- 映射 threadId / turnId。
- 用户 approve/decline 后回 response。
- serverRequest/resolved 后同步状态。

## 3.4 Channel Approval 通知

QQ/微信/飞书统一最低能力：

```text
/approve
/decline
```

任务：

- approval notification formatter。
- command parser。
- 只允许 pending approval resolve。

## 3.5 MCP Approval

实现：

- list pending approvals（可通过 list_tasks/get_task 聚合）。
- resolve_approval。

## 3.6 Control API + Admin Approval

新增：

- pending approval query。
- resolve endpoint。
- 首页行动项。
- Task Detail approval event。

Phase 3 DoD：

- [ ] Codex 请求命令执行权限。
- [ ] 微信收到通知。
- [ ] 用户 /approve。
- [ ] Codex 继续。
- [ ] Admin/MCP 状态同步为 resolved。

---

# Phase 4 — Runtime Reliability

## 4.1 Transport Isolation

修改 UnifiedDesktopDriver。

任务：

- 移除“单 Session fallback 改全局 activeTransport”的行为。
- global preferred = app-server。
- per-session effective transport。
- fallbackReason / fallbackAt。
- recoverOnNextTurn。

测试：

场景 A：

```text
Session A AppServer pre-submit fail → CDP
Session B → 仍 AppServer
```

场景 B：

```text
A messageAccepted=true
→ 后续异常
→ 不允许 CDP 重新提交
```

## 4.2 Durable Turn Ledger

新建：

```text
packages/task-ledger/
```

实现 TurnRepository。

替换关键进程内 Map 状态为持久化 checkpoint。

## 4.3 Delivery Checkpoint

任务：

- text offset。
- artifact key。
- successful delivery 后 checkpoint。
- failed delivery 不提前推进。

## 4.4 Crash Recovery

Runtime 启动：

- 读取 queued/running/unknown turn。
- 查询 Codex 当前状态。
- reconcile。
- 已完成但未 final delivered → 补发未发送部分。
- 不盲目重新 startTurn。

Phase 4 DoD：

- [ ] 单 Session fallback 隔离。
- [ ] Runtime 中途重启不会明显重复最终消息。
- [ ] final reply 可恢复。

---

# Phase 5 — Control Center UI

UI 最后做，避免后端协议未稳定时重复返工。

## 5.1 导航重构

目标：

```text
首页
渠道
对话
任务
自动化
智能路由
系统
```

不增加 Remote。

## 5.2 首页

实现：

- Runtime 状态。
- running tasks count。
- pending approvals count。
- channels online count。
- actionable notices。
- running tasks。
- channel summary。

## 5.3 Channels

任务：

- 卡片式账号状态。
- 连接/重新登录。
- test/restart。
- 使用 Setup Service。

## 5.4 Tasks

实现过滤：

- all
- running
- waiting approval
- completed
- failed

列表不突出技术 ID。

## 5.5 Task Detail

实现 Timeline：

- inbound
- started
- file read/change
- approval
- decision
- command
- completed/failed

## 5.6 MCP 页面

展示：

- MCP status。
- auto bootstrap 状态。
- last hosts。
- 推荐配置。

## 5.7 Runtime / Diagnostics

Runtime：

- PID
- uptime
- version
- AppServer
- CDP
- DB

Diagnostics：

- human-readable cause
- suggested action
- technical details collapsible

## 5.8 Router UX

将技术参数收进高级设置。

第一层展示：

- off / assist / auto
- high confidence action
- clarify range
- low confidence fallback

Phase 5 DoD：

- [ ] 非开发者可以理解首页。
- [ ] 能在 Admin 完成渠道连接。
- [ ] 能看 Task Timeline。
- [ ] 能处理 Approval。
- [ ] 技术细节默认渐进披露。

---

# Phase 6 — Release Hardening

## 6.1 全链路回归

必须验证：

- QQ → Codex → QQ
- 微信 → Codex → 微信
- 飞书 → Codex → 飞书
- MCP auto bootstrap
- MCP setup
- Approval
- Push
- Router
- Admin

## 6.2 Upgrade Test

从真实 v0.2 配置升级到 v0.3：

- 不丢 Channel。
- 不丢 binding。
- 不暴露 Secret。
- 可以 rollback。

## 6.3 Failure Injection

测试：

- AppServer 掉线。
- CDP unavailable。
- Channel disconnect。
- Runtime crash。
- SQLite temporary error。
- MCP host simultaneous launch。

---

# 任务依赖图

```text
RuntimeManager
   ↓
MCP Bootstrap
   ↓
Config/Secret Store
   ↓
Setup Domain
   ├── 微信 Setup
   ├── QQ Setup
   └── 飞书 Setup
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

每个任务应尽量保持独立 commit，例如：

```text
feat(runtime): add singleton runtime manager
feat(mcp): bootstrap runtime on server startup
feat(config): add versioned config store
feat(secrets): add secret reference store
feat(setup): add persistent setup session domain
feat(setup-weixin): add QR login artifacts
feat(setup-qq): add credential setup provider
feat(approval): handle app-server server requests
fix(transport): isolate CDP fallback per session
feat(ledger): persist turn delivery checkpoints
feat(ui): add task-centric control center
```

---

# 每个任务的完成标准

每个 Task 合入前必须同时满足：

1. 类型检查通过。
2. 新增单测通过。
3. 三渠道回归不受影响。
4. 不新增未文档化的公网监听。
5. 不产生 Secret 明文日志。
6. 不将 CDP 提升为主通道。
7. 对应 PRD/ARCHITECTURE 约束未违反。

---

# 首条端到端 Milestone

最先打通以下链路，作为 v0.3 M1：

```text
用户添加 MCP
  ↓
MCP ensureRuntime
  ↓
Runtime 自动 ready
  ↓
用户说“帮我连接微信”
  ↓
AI 显示二维码
  ↓
用户扫码
  ↓
微信 Channel connected
  ↓
用户在微信发消息
  ↓
Codex AppServer turn/start
  ↓
回复返回微信
```

在 M1 未打通前，不应开始大规模 Admin UI 重构。
