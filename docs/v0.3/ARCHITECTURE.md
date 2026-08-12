# v0.3 技术架构与开发规范

## 1. 总体原则

v0.3 必须建立在 `codex/v0.2-unified-refactor` 已有分层之上演进，不回退为“渠道代码直接操作 Codex / 配置 / Runtime”的模式。

推荐主链路：

```text
QQ / 微信 / 飞书
        │
        ▼
Channel Adapter
        │
        ▼
Application Service
        │
 ┌──────┼─────────┐
 │      │         │
Setup  Task    Approval
 │      │         │
 └──────┼─────────┘
        │
      Ports
        │
   Codex AppServer
        │
      PRIMARY
        │
   CDP Recovery
      FALLBACK
```

MCP 和 Admin 都必须调用 Application Service，不允许绕过应用层直接写配置、Secret 或 Session。

---

## 2. RuntimeManager 规范

建议新增：

```text
packages/runtime-manager/
```

接口：

```ts
interface RuntimeManagerPort {
  ensureRunning(): Promise<RuntimeStatus>;
  start(): Promise<RuntimeStatus>;
  stop(): Promise<void>;
  restart(): Promise<RuntimeStatus>;
  getStatus(): Promise<RuntimeStatus>;
  doctor(): Promise<RuntimeDiagnostic[]>;
}
```

### 2.1 Runtime 状态文件

建议目录：

```text
~/.qq-codex-bridge/runtime/
```

文件：

```text
runtime.json
runtime.lock
bridge.pid
bridge.log
```

`runtime.json` 至少包含：

```json
{
  "pid": 0,
  "version": "0.3.0",
  "state": "ready",
  "startedAt": "",
  "controlUrl": "http://127.0.0.1:0"
}
```

### 2.2 启动算法

```text
ensureRunning()
  ↓
读取 runtime.json
  ↓
PID 存活？
  ├─ 是 → health check
  │       ├─ ready → reuse
  │       └─ unhealthy → 尝试恢复/重启
  │
  └─ 否 → 清理 stale state
          ↓
       获取 lock
          ↓
       二次检查
          ↓
       spawn runtime
          ↓
       wait health ready
          ↓
       写 runtime.json
```

必须有二次检查，避免两个 MCP Host 同时获取启动机会时产生竞态。

### 2.3 生命周期

- MCP 启动时可调用 `ensureRunning()`。
- MCP 退出不得自动 stop Runtime。
- Runtime 自身需要优雅处理 SIGINT/SIGTERM。
- Admin 重启 Runtime 必须通过 RuntimeService，不得直接 kill PID。

---

## 3. MCP 规范

建议新增独立 package：

```text
packages/mcp-control/
```

MCP 层只负责：

- Tool schema
- 参数校验
- 调用 Application Service
- 将领域结果映射成适合 AI 使用的结构化结果

不得：

- 自己管理 Secret
- 自己写 Config Store
- 自己管理 Channel SDK
- 自己连接 Codex AppServer

工具命名要保持任务语义，不暴露过多内部技术概念。

---

## 4. Setup Domain

建议新增：

```text
packages/setup/
```

核心类型：

```ts
type SetupState =
  | "needs_input"
  | "waiting_scan"
  | "scanned"
  | "confirming"
  | "applying"
  | "connected"
  | "failed"
  | "cancelled"
  | "expired";
```

Artifact：

```ts
type SetupArtifact =
  | QrCodeArtifact
  | FormArtifact
  | UrlArtifact
  | InstructionArtifact
  | StatusArtifact;
```

渠道不得定义完全独立的 Setup API；渠道应实现统一 Port，例如：

```ts
interface ChannelSetupProvider {
  start(input: StartSetupInput): Promise<SetupSession>;
  submit(input: SubmitSetupInput): Promise<SetupSession>;
  getProgress(setupId: string): Promise<SetupSession>;
  cancel(setupId: string): Promise<void>;
}
```

---

## 5. Config Store 与 Secret Store

### 5.1 Config Store

普通业务配置持久化到结构化 Config Store。

要求：

- schema version
- migration
- atomic write / transaction
- revision
- validation

### 5.2 Secret Store

Secret 与 Config 分离。

Config：

```json
{
  "channel": "qq",
  "appId": "xxx",
  "clientSecretRef": "channels/qq/default/client-secret"
}
```

Secret API 只允许：

```text
set
exists
replace
delete
```

禁止公开：

```text
getPlainTextSecret
listSecretValues
exportSecrets
```

如果内部 Channel Runtime 必须读取 Secret，应通过受限内部 Port 获取，不得通过 MCP/Control API 暴露。

---

## 6. Approval 架构

Codex AppServer 需要区分三类消息：

1. JSON-RPC response
2. notification
3. server request

Approval 属于 server request，不应被当普通 notification 处理。

建议新增：

```text
packages/approval/
```

接口：

```ts
interface ApprovalService {
  listPending(): Promise<ApprovalRequest[]>;
  resolve(id: string, decision: "approve" | "decline"): Promise<ApprovalRequest>;
}
```

AppServer Adapter 必须保存 request id 与 Codex server request 的关联，并在用户决策后发送对应 JSON-RPC response。

要求：

- 幂等 resolve
- 已 resolved 不重复执行
- 可审计
- 渠道和 Admin 状态同步

---

## 7. Transport Isolation

当前 UnifiedDesktopDriver 的目标结构应调整为：

```ts
RuntimeTransportState {
  preferred: "app-server";
  appServerHealth: ...;
  cdpHealth: ...;
}

SessionTransportState {
  effectiveTransport: "app-server" | "cdp";
  fallbackReason?: string;
  fallbackAt?: string;
  recoverOnNextTurn: boolean;
}
```

规则：

1. AppServer 永远是全局 preferred transport。
2. 单 Session fallback 不调用全局 `setActive("cdp")`。
3. 只有 safe pre-submit failure 才允许自动 fallback。
4. messageAccepted 后严禁自动切 transport 重新提交。
5. 下一 Turn 默认重新 probe AppServer。

---

## 8. Durable Turn Ledger

建议新增：

```text
packages/task-ledger/
```

Turn 状态不得仅保存在 Map。

最低数据结构：

```text
turns
- turn_id
- thread_id
- session_key
- space_id
- status
- transport
- idempotency_key
- last_sequence
- delivered_text_offset
- queued_at
- started_at
- completed_at
- failure_code
- failure_message
```

如媒体需要独立 checkpoint，再新增：

```text
turn_artifact_delivery
```

要求：

- 所有状态变化事务化。
- Delivery checkpoint 在发送成功后更新。
- 重启后可加载未终态 Turn。
- 对未知状态执行 reconcile，而不是盲目重发。

---

## 9. Channel 规范

QQ / 微信 / 飞书继续保持独立 Adapter/Runtime。

每个 Channel 至少实现：

- health
- start/restart/stop
- setup
- receive inbound
- deliver outbound
- approval notification
- approval command parsing（最低能力）

Channel 层禁止直接操作 Codex。

---

## 10. Control UI 规范

UI 不新增 Remote 页面。

设计原则：

- 行动优先：等待审批、失败任务、掉线渠道先显示。
- 任务优先：Task 是用户对象，Thread/Turn 是高级技术信息。
- 渐进披露：PID、transport、revision、threadId 放到详情/系统页。
- Admin 与 MCP 使用同一个 SetupService / TaskService / ApprovalService。

---

## 11. Control API 规范

继续保持：

- loopback-only
- local session
- CSRF
- SameSite

不得为了 MCP 或 AI Setup 把 Control API 改为公网接口。

如果 MCP 与 Runtime 在同机，可直接调用内部 Application Service 或受限本地 API，但权限边界需保持清晰。

---

## 12. Migration 规范

从 v0.2 升级时：

1. 检测旧 `.env`。
2. 读取可迁移普通配置。
3. Secret 写入新 Secret Store。
4. Config 中生成 secretRef。
5. 保留 ENV override 兼容。
6. Migration 必须可重复执行且幂等。
7. 迁移失败不得破坏原配置。

---

## 13. 测试规范

每个新包必须有单测。

关键集成测试：

- Runtime 并发 ensureRunning。
- stale PID / stale lock recovery。
- MCP 首次自动启动 Runtime。
- 微信 QR Setup 状态机。
- QQ/飞书 Secret 不回显。
- Approval server request -> resolve。
- 单 Session CDP fallback 不污染全局。
- messageAccepted 后禁止 fallback 重发。
- Turn Ledger crash recovery。
- 老配置 migration。

端到端 smoke：

- 微信完整链路
- QQ 完整链路
- 飞书完整链路
- Approval 完整链路

---

## 14. 禁止事项

本分支实现期间禁止：

- 新建 Remote Device / Remote UI。
- 将 Control API 监听到 0.0.0.0。
- 将 AppServer 暴露到非 loopback。
- 以 Accessibility 替代 AppServer 主链路。
- 在 MCP 中暴露任意 shell command。
- 在 API/MCP/Admin 中读取 Secret 明文。
- 为了快速实现让 MCP 和 Admin 各写一套配置逻辑。
