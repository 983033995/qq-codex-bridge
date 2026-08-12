# OmniAgent Gateway v0.3 技术架构与开发规范

## 1. 总体原则

v0.3 必须建立在 `codex/v0.2-unified-refactor` 已有分层之上演进，不回退为“渠道代码直接操作 Codex / 配置 / Runtime”的模式。

产品显示名统一为 **OmniAgent Gateway**；旧的 `qq-codex-bridge` 仅作为兼容标识存在。

### 1.1 推荐主链路

```text
QQ / 微信 / 飞书
        │
        ▼
Channel Adapter
        │
        ▼
Inbound Gateway
        │
        ▼
Inbound Intelligent Router
  ┌─────┼────────┬──────────┬──────────┐
  ▼     ▼        ▼          ▼          ▼
Conversation  Control     Setup     Approval   Clarify
  │          │          │          │
  └──────────┼──────────┼──────────┘
             ▼
      Application Services
             │
          Domain/Ports
             │
      Codex AppServer
          PRIMARY
             │
       CDP Recovery
          FALLBACK
```

### 1.2 强制边界

- 所有渠道入站消息必须先进入 `InboundGateway`。
- `InboundGateway` 默认必须调用 `InboundRouter`，不得由 Channel Adapter 直接调用 Codex。
- Router 只负责“判断和分发”，不直接修改配置、不直接执行 Approval、不直接操作 Channel SDK。
- Router 的输出必须交给 Application Service 执行。
- MCP 和 Admin 同样调用 Application Service，不允许绕过应用层直接写配置、Secret、Session 或 Approval。
- Codex AppServer 是 v0.3 唯一主 Conversation Transport；CDP 只是单 Session pre-submit recovery。

---

## 2. Inbound Intelligent Router

建议新增/重构为独立 package：

```text
packages/router/
```

核心接口：

```ts
type RouterIntentKind =
  | "conversation"
  | "control"
  | "setup"
  | "approval"
  | "unknown";

type RouterDecision = {
  decisionId: string;
  kind: RouterIntentKind;
  action?: string;
  target?: string;
  confidence: number;
  arguments?: Record<string, unknown>;
  clarification?: string;
  risk: "read" | "low" | "medium" | "high";
};

interface InboundRouterPort {
  decide(input: RouterInput): Promise<RouterDecision>;
}
```

### 2.1 Deterministic Parser First

对于完全确定且安全的命令，优先在模型 Router 前解析：

- `/approve`
- `/decline`
- 明确的内部命令别名

确定性命令不需要消耗 Router 模型调用，也不能因为 Router Provider 故障而失效。

### 2.2 Router Provider

自然语言 Router 可以使用独立 LLM Endpoint，但必须封装在 Port 后面：

```text
RouterService
    │
    ▼
RouterProviderPort
    │
    ├── OpenAI-compatible provider
    └── future provider
```

Application 层不得依赖具体供应商 SDK。

### 2.3 Mode

```ts
type RouterMode = "off" | "assist" | "auto";
```

- `off`：默认直接 `conversation`，仅确定性命令仍可生效。
- `assist`：执行分类，但中高风险操作可以要求确认。
- `auto`：高置信低/中风险意图自动分流；中等置信度进入 clarify。

### 2.4 Threshold

建议默认：

```text
highConfidenceThreshold = 0.90
clarifyThreshold = 0.50
```

规则：

```text
>= high          → route
>= clarify       → clarify
< clarify        → conversation fallback
```

高风险动作仍必须通过对应 Service 的授权规则；Router confidence 不能代替授权。

### 2.5 Failure Fallback

Router timeout / provider error / invalid schema：

1. 记录 `router.degraded` 事件。
2. 不执行猜测出的 control/setup/approval。
3. 默认将原消息作为 `conversation` 发送给 Codex。
4. 如果 deterministic parser 已识别明确审批命令，则优先执行该命令。
5. 不允许丢弃原始 InboundMessage。

### 2.6 Decision Store

所有决策持久化：

```text
router_decisions
- decision_id
- message_id
- session_key / space_id
- kind
- action
- target
- confidence
- risk
- mode
- latency_ms
- result
- fallback_reason
- created_at
```

Router 决策必须进入 observability，Admin 可查询。

### 2.7 Dispatcher

Router 后必须通过统一 dispatcher：

```ts
interface IntentDispatcher {
  dispatch(message: InboundMessage, decision: RouterDecision): Promise<void>;
}
```

映射：

- `conversation` → ConversationService / Codex
- `control` → RuntimeService / ChannelControlService / ThreadControlService
- `setup` → SetupService
- `approval` → ApprovalService
- `unknown` → ClarificationService 或 conversation fallback

禁止 Channel Adapter 自己实现这些判断。

---

## 3. RuntimeManager 规范

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

### 3.1 Runtime 状态文件

建议迁移后的产品目录：

```text
~/.omniagent-gateway/
```

兼容期必须读取旧目录：

```text
~/.qq-codex-bridge/
```

新目录至少包含：

```text
runtime/runtime.json
runtime/runtime.lock
runtime/bridge.pid
runtime/bridge.log
config/config.json
data/gateway.sqlite
```

### 3.2 启动算法

```text
ensureRunning()
  ↓
读取 runtime.json
  ↓
PID 存活？
  ├─ 是 → health check
  │       ├─ ready → reuse
  │       └─ unhealthy → recover/restart
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

必须有二次检查，避免两个 MCP Host 并发启动两个 Runtime。

### 3.3 生命周期

- MCP 启动时可调用 `ensureRunning()`。
- MCP 退出不得自动 stop Runtime。
- Runtime 自身需要优雅处理 SIGINT/SIGTERM。
- Admin 重启 Runtime 必须通过 RuntimeService，不得直接 kill PID。

---

## 4. MCP 规范

建议 package：

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
- 自己实现 Router 逻辑

MCP 与 Router 的职责必须严格分开。

---

## 5. Setup Domain

建议：

```text
packages/setup/
```

核心状态：

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

渠道应实现统一 `ChannelSetupProvider`，MCP、Admin、Router 都调用同一个 SetupService。

---

## 6. Config Store 与 Secret Store

### Config Store

要求：schema version、migration、atomic write/transaction、revision、validation。

### Secret Store

Config 只保存 `secretRef`。

Secret API 对外只允许：

```text
set
exists
replace
delete
```

禁止 MCP/Control API/Admin 读取明文 Secret。

---

## 7. Approval 架构

Codex AppServer 必须区分：

1. JSON-RPC response
2. notification
3. server request

Approval 属于 server request。

建议：

```text
packages/approval/
```

渠道自然语言审批经过 Router 或 deterministic parser 后进入 ApprovalService；不得作为普通 Prompt 进入 Codex。

---

## 8. Transport 架构

统一模型：

```text
Global Preferred = app-server

Per Session Effective
├── app-server
└── cdp
```

禁止单 Session fallback 调用全局 `setActive("cdp")` 影响其他 Session。

`messageAccepted=true` 后不允许通过 CDP 重交同一消息。

---

## 9. Durable Turn Ledger

建议：

```text
packages/task-ledger/
```

持久化 Turn 状态、sequence、delivery offset、artifact checkpoint、failure 和时间信息。

Runtime 重启后必须 reconcile，而不是盲目重新 startTurn。

---

## 10. Application Service 边界

推荐核心服务：

```text
ConversationService
ChannelSetupService
ChannelControlService
RuntimeService
TaskService
ApprovalService
RouterService
DiagnosticsService
```

MCP、Admin、Router Dispatcher 都只能调用这些服务。

---

## 11. Control API 安全

- 继续 loopback-only。
- Local session + CSRF 保留。
- 不因为 MCP 自动启动而开放公网地址。
- Router Provider 的 Secret 只能通过 SecretRef 引用。

---

## 12. Observability

统一结构化事件至少增加：

```text
runtime.*
router.decision
router.degraded
router.fallback
setup.*
approval.*
turn.*
channel.*
```

每个事件尽量带：correlationId / messageId / sessionKey / turnId / decisionId。

---

## 13. 命名兼容规范

产品显示名：`OmniAgent Gateway`。

内部新模块避免继续使用 `qqcb` / `qq-codex` 作为领域名称；旧数据库表、ENV、CLI 可在兼容层保留。

目标 CLI：

```text
omniagent-gateway mcp
omniagent-gateway status
omniagent-gateway doctor
```

兼容 CLI：

```text
qq-codex-bridge ...
qq-codex-mcp ...
```

兼容命令在 v0.3 不删除，只转发到同一 Runtime/Application 层。

---

## 14. 架构验收红线

任何实现若出现以下行为，视为不符合 v0.3：

- Channel Adapter 直接把所有消息送 Codex，绕过 Router。
- Router 直接操作 SDK/Secret/AppServer。
- MCP 实现第二套配置逻辑。
- Router Provider 故障导致入站消息丢失。
- 单 Session CDP fallback 改变全局 Transport。
- Secret 通过 MCP/Admin/API 被读回。
- 为了“远程”开放 Control API/AppServer 公网监听。
- 新代码继续把产品显示名写成 `QQ Codex Bridge`。
