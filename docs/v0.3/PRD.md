# OmniAgent Gateway v0.3 PRD — AI Control Center

## 1. 背景

当前 `codex/v0.2-unified-refactor` 已完成多渠道、AppServer、CDP Recovery、Control UI、Router、Push/MCP 等能力的统一重构，但仍存在几个明显的产品化问题：

- Runtime 仍需要用户主动在终端启动。
- MCP 依赖既有 Runtime，不能自行确保服务可用。
- 普通用户仍需要理解 `.env`、npm/pnpm、AppServer、PID 等实现细节。
- 渠道初始化缺少统一的 AI 驱动 Setup Protocol。
- Codex Approval 尚未成为统一的产品能力。
- 部分 Turn 状态仍依赖进程内存，重启恢复能力不足。
- 现有 Router 尚未被正式定义为所有渠道消息的统一入站分发层。
- Control UI 仍偏工程管理后台，尚未完全以“任务 / 审批 / 渠道”组织信息。
- 旧产品名 `qq-codex-bridge` 已不能覆盖 QQ / 微信 / 飞书 / MCP / Router / Control Center 的真实产品边界。

## 2. 产品命名与定位

### 2.1 新产品名

v0.3 起产品显示名统一为：

> **OmniAgent Gateway**

定位：

> 一个本地运行的多渠道 Agent Gateway。它接收 QQ、微信、飞书消息，通过 Inbound Intelligent Router 判断用户意图，再将请求分发给 Codex Conversation、系统控制、渠道配置或 Approval；同时通过 MCP 为 Codex、Claude、OpenCode 等 AI Host 提供初始化、管理、诊断和主动推送能力。

### 2.2 兼容标识

- GitHub 仓库 `qq-codex-bridge` 暂时保留，待正式发布窗口再执行仓库迁移。
- npm 包和旧 CLI 名称在 v0.3 保留兼容别名，不能直接硬删除。
- UI、文档、日志的人类可见产品名统一改为 `OmniAgent Gateway`。
- 新 CLI 目标名建议为 `omniagent-gateway`，旧命令提供兼容转发和弃用提示。

## 3. 产品形态

- **QQ / 微信 / 飞书**：日常消息入口。
- **Inbound Intelligent Router**：所有渠道入站消息的统一意图判断与分发层。
- **MCP**：AI 驱动的初始化、控制、诊断和 Push 入口。
- **Control UI**：高级配置、可视化任务、审批、Router 决策、日志与诊断入口。
- **Runtime**：独立常驻的本地服务。
- **Codex AppServer**：v0.3 唯一主 Agent Conversation 控制通道。
- **CDP**：仅作为安全的单会话 pre-submit recovery。

不新增独立 Remote 产品。

## 4. 核心用户链路

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
  ▼          ▼          ▼          ▼
Codex     Runtime/    Channel    Approval
          Channel     Setup      Service
          Control
```

任何渠道入站消息不得绕过 Router 直接进入 Codex，除非 Router 处于明确的 `off` 模式；即使 Router 不可用，也必须按定义好的 fallback 规则回退，而不是丢消息。

## 5. 用户目标

### 新用户

1. 添加 MCP。
2. 直接对 AI 说“帮我连接微信/QQ/飞书”。
3. AI 自动拉起 Runtime。
4. AI 在当前对话中展示二维码或收集配置字段。
5. 渠道连接成功后直接使用。
6. 无需进入终端。

### 日常用户

希望在 QQ / 微信 / 飞书里自然说话，无需区分“聊天命令”和“Codex Prompt”。例如：

- `帮我排查订单页报错` → Conversation → Codex。
- `重启一下微信渠道` → Control → Channel Control。
- `帮我重新登录微信` → Setup → 微信扫码。
- `允许刚才的 pnpm test` → Approval → Resolve Approval。

### 老用户

1. 现有 `.env` / SQLite / Channel / Router 配置可平滑迁移。
2. 升级后无需重新登录全部渠道。
3. 原有 Push/MCP、QQ/微信/飞书消息能力保持兼容。
4. 原有 Router 配置尽可能自动迁移到新的 Intent Router 配置结构。

## 6. P0 — Runtime 自动拉起

新增 RuntimeManager：

- `ensureRunning()`
- `start()`
- `stop()`
- `restart()`
- `getStatus()`
- `doctor()`

Runtime 必须：

- 单实例运行。
- 支持 PID + lock + health check。
- 能清理 stale PID / stale lock。
- 多个 MCP Host 同时启动时只产生一个 Runtime。
- MCP 退出后 Runtime 不自动退出。

## 7. P0 — MCP AI Control Plane

### Setup

- `get_setup_status`
- `start_setup`
- `submit_setup`
- `get_setup_progress`
- `cancel_setup`

### Channels

- `list_channels`
- `test_channel`
- `restart_channel`
- `remove_channel`

### Tasks

- `list_tasks`
- `get_task`
- `interrupt_task`
- `resolve_approval`

### Push

保留现有 Push 能力。

### System

- `get_runtime_status`
- `doctor`
- `restart_runtime`
- `get_admin_url`

MCP 不得 1:1 暴露所有 Control API。

## 8. P0 — Inbound Intelligent Router

### 8.1 定位

Router 负责理解 **QQ / 微信 / 飞书的自然语言入站消息到底应该进入哪个 Application Service**。

Router 与 MCP 是两个独立概念：

- Router：渠道用户 → OmniAgent Gateway 的入站意图分发。
- MCP：外部 AI Host → OmniAgent Gateway 的工具调用入口。

### 8.2 Intent 类型

v0.3 至少支持：

```text
conversation
control
setup
approval
unknown
```

建议标准结果：

```ts
type RouterDecision = {
  kind: "conversation" | "control" | "setup" | "approval" | "unknown";
  action?: string;
  target?: string;
  confidence: number;
  clarification?: string;
  arguments?: Record<string, unknown>;
};
```

### 8.3 典型映射

- `帮我修一下订单详情页` → `conversation`。
- `切到上一个项目线程` → `control.thread.switch`。
- `重启微信` → `control.channel.restart`。
- `帮我连接飞书` → `setup.channel.connect`。
- `重新生成微信二维码` → `setup.channel.login`。
- `允许刚才那个命令` → `approval.resolve.approve`。
- `拒绝这次文件修改` → `approval.resolve.decline`。

### 8.4 置信度策略

保留现有三段式思想，并正式产品化：

- **高置信度**：`confidence >= highConfidenceThreshold`，允许自动路由到对应 Service。
- **中等置信度**：`clarifyThreshold <= confidence < highConfidenceThreshold`，必须向用户澄清，不得执行高风险动作。
- **低置信度**：`confidence < clarifyThreshold`，默认按普通 `conversation` 处理，除非命中明确的安全规则。

默认建议：

- high = 0.90
- clarify = 0.50

### 8.5 Router Mode

- `off`：所有普通入站消息进入 Conversation；仅保留显式、确定性的安全命令解析。
- `assist`：Router 给出决策，但中高风险 control/setup/approval 可要求确认。
- `auto`：高置信度意图自动执行；中等置信度澄清。

### 8.6 风险等级

Router action 必须标记风险：

- `read`：查询状态、列表。
- `low`：切换线程、测试渠道。
- `medium`：重启渠道、重新登录、修改 Router 配置。
- `high`：Approval、删除配置、可能影响执行状态的操作。

高风险动作即使 confidence 很高，也必须遵守对应 Service 的授权策略，Router 本身无权绕过确认。

### 8.7 Router Failure Fallback

Router 不可用、超时或模型调用失败时：

1. 不得丢弃渠道消息。
2. 不得猜测控制意图并执行。
3. 默认回退到 `conversation`。
4. 若消息明显是 `/approve`、`/decline` 等确定性命令，则可由 deterministic parser 优先处理。
5. 记录 Router failure event，供 Admin Diagnostics 查看。

### 8.8 Router 决策审计

每次 Router 决策持久化：

- decisionId
- messageId
- session/space
- kind/action/target
- confidence
- latencyMs
- mode
- result
- fallbackReason
- createdAt

Admin 必须支持查看最近 Router 决策。

## 9. P0 — Capability Readiness

不得使用单一 `initialized: true/false` 代表整个系统。

至少区分：Runtime、Codex、Router、QQ、微信、飞书。

只要 Runtime + Codex + 任意一个 Channel ready，系统即可使用；Router degraded 时系统仍可按 fallback 提供普通 Conversation。

## 10. P0 — Setup Protocol

所有渠道统一通过 Setup Session 实现。

Setup Session 至少包含：`setupId`、`target`、`type`、`state`、`requiredFields`、`completedFields`、`artifacts`、`createdAt`、`updatedAt`、`expiresAt`、`error`。

Setup Artifact：QR Code / Form / URL / Instruction / Status。

### 微信

`waiting_scan -> scanned -> confirming -> connected`，二维码过期可重新生成。

### QQ

收集 AppID / ClientSecret，Secret 写入 Secret Store，启动并测试 Channel。

### 飞书

收集 App ID / App Secret，成功后启动长连接并健康检查。

## 11. P0 — Secret Store

- Secret 独立保存。
- Config 只保存 `secretRef`。
- MCP/Admin 只能看到 configured 状态。
- 支持替换和删除，不支持明文读取。
- ENV 仅作为高级 override。

## 12. P0 — Approval Center

支持 command execution approval 与 file change approval。

QQ/微信/飞书至少支持纯文本审批命令；Approval 必须可审计，并通过 Router/确定性命令解析进入 ApprovalService，不能被当普通 Codex Prompt。

## 13. P0 — Transport Isolation

全局 preferred transport = AppServer。

单 Session safe pre-submit failure 可降级 CDP，但仅影响当前 Session；下一轮优先重试 AppServer，并记录 fallbackReason / fallbackAt。

## 14. P0 — Durable Turn Ledger

持久化 turnId、threadId、sessionKey/spaceId、status、transport、idempotencyKey、lastSequence、deliveredTextOffset、时间与失败信息。

目标：Runtime 重启后不明显重复回复、不丢 Final Reply、不重复媒体。

## 15. Control UI

### 首页

优先展示 Runtime、Router 状态、正在运行任务、等待审批、在线渠道、需要处理事项。

### 渠道

QQ / 微信 / 飞书账号状态、最后活动、测试、重启、重新登录、编辑配置。

### 任务

以 Task 为主对象：全部 / 进行中 / 等待确认 / 已完成 / 失败。

### Intelligent Router

第一层展示：

- 模式：off / assist / auto
- 当前状态：ready / degraded / offline
- 高置信自动执行阈值
- 澄清阈值
- 低置信 fallback
- 最近决策

高级设置中展示：Endpoint、Model、Secret Reference、超时等技术参数。

### Task Detail

显示 inbound、Router Decision、Codex start、文件变更、Approval、用户决策、命令执行、完成/失败时间线。

### MCP

MCP 状态、Runtime 自动拉起、最近 Host、推荐配置。

### System

Runtime / Diagnostics 显示 PID、AppServer、CDP、SQLite、Router Provider、版本、日志与建议。

## 16. 非功能要求

### 安全

- Control API / AppServer loopback-only。
- Secret 不可读回。
- MCP 不提供任意 shell / 任意 config mutation。
- Router 不得绕过 Service 层授权。
- Approval 可审计。

### 可靠性

- RuntimeManager 并发安全。
- Router 失败不丢消息。
- Setup Session / Turn Ledger 可恢复。
- Channel 重启互不影响。

### 兼容性

- 不破坏 QQ / 微信 / 飞书主链路。
- 不破坏 Push/MCP。
- ENV 可继续用于开发/自动部署。
- 旧 `qq-codex-bridge` CLI / npm 名称在迁移期继续可用。

## 17. v0.3 明确不做

- Remote 页面或设备体系。
- 手机/PWA/独立桌面客户端。
- Cloudflare Relay。
- 让 Claude / OpenCode 成为 QQ/微信/飞书入站消息的执行 Agent。
- 多 Agent Provider 路由；该能力留给后续版本。

## 18. Definition of Done

- 配置 MCP 后无需手动启动 Runtime。
- 新用户无需编辑 `.env`。
- 微信可在 AI 对话中扫码初始化。
- QQ / 飞书可在 AI 对话中完成凭据配置。
- **所有渠道消息通过 Inbound Intelligent Router 分流。**
- conversation/control/setup/approval/unknown 五类意图有自动化测试。
- Router 超时/异常时普通消息安全回退 Codex Conversation。
- Control/Setup/Approval 意图不会误发给 Codex。
- Admin 可查看 Router 状态和决策记录。
- Secret 不可读回。
- Approval 可从渠道和 Admin 处理。
- CDP fallback 仅影响当前 Session。
- Turn 状态持久化。
- 老用户配置可迁移。
- UI 产品名统一为 OmniAgent Gateway。
- 旧 CLI/npm 标识在兼容期仍可用。
