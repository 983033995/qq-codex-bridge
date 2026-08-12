# OmniAgent Gateway v0.3 — Conversation Source & Reply Routing

> 本文档是 v0.3 PRD 的强制组成部分，优先级 **P0**。任何涉及 QQ / 微信 / 飞书出入站消息、Codex Thread、MCP Push、Task Timeline、Router 或 Channel Sender 的实现都必须遵守本文档。

## 1. 背景与问题

v0.3 允许以下来源同时向同一个 QQ / 微信 / 飞书会话发送消息：

- 多个 Codex Thread；
- 同一个 Codex 下的多个项目 / Task；
- Claude / OpenCode / 其他 MCP Host 的主动 Push；
- 系统通知、Approval、Setup、Diagnostics。

如果没有统一的来源身份与回复路由，用户会遇到两个不可接受的问题：

1. **不知道消息是谁、从哪个项目 / Thread / Task 发来的。**
2. **不知道自己下一句话会被发到哪里。**

因此 v0.3 必须引入统一的 **Source Identity + Conversation Alias + Active Conversation + Reply Routing**。

---

## 2. 产品目标

### 2.1 用户必须始终知道消息来源

面向用户的消息至少要能表达：

- Agent / Provider；
- 项目或任务标题；
- 稳定、短、可输入的 Conversation Alias。

不得要求用户识别内部 Thread ID / UUID。

### 2.2 用户回复必须有确定目标

回复目标解析优先级固定为：

```text
1. 显式引用 / reply-to 映射
2. 显式 Alias / 切换指令
3. 当前 Active Conversation
4. 无法确定时澄清
```

不得使用“最后一个向渠道发消息的来源”作为隐式回复目标。

### 2.3 Agent 主动 Push 不得偷换当前会话

Agent / Task 的 outbound push **默认不得修改 Active Conversation**。

只有用户显式行为可以修改 Active Conversation，例如：

- 引用某个可继续的 Conversation 并回复；
- `/use C7K2`；
- `切到 PageMind 那个任务`；
- 在 Admin 中手动设为当前会话。

---

## 3. 核心领域概念

### 3.1 Source Identity

统一来源模型：

```ts
interface SourceIdentity {
  provider: "codex" | "claude" | "opencode" | "system" | string;
  instanceId?: string;
  conversationId?: string;
  conversationAlias?: string;
  projectId?: string;
  projectName?: string;
  taskId?: string;
  taskTitle?: string;
  capability: "interactive" | "push_only" | "system";
}
```

说明：

- `provider`：消息来自哪个 Agent / 系统；
- `conversationId`：内部真实 Conversation，例如 Codex threadId；
- `conversationAlias`：面向用户的稳定短标识；
- `capability=interactive`：渠道回复可以继续该 Conversation；
- `capability=push_only`：只允许主动推送，不允许从渠道反向继续该 Agent 会话；
- `system`：Approval / Setup / Diagnostics 等系统消息。

### 3.2 Conversation Alias

Alias 是用户可见、可输入、稳定的短 ID，例如：

```text
#C7K2  Codex
#C9P1  Codex
#A4M8  Claude Push
#O2F6  OpenCode Push
```

规则：

- 同一 Conversation 在生命周期内 Alias 不变；
- Alias 在当前 Gateway 实例内唯一；
- Alias 不暴露 Thread UUID；
- Provider 前缀仅用于提高辨识度，不作为权限依据；
- Alias 冲突必须重新生成；
- Alias 与内部 Conversation 的映射必须持久化。

推荐前缀：

```text
C = Codex
A = Claude
O = OpenCode
S = System
```

未来新增 Provider 可扩展，但不得改变既有 Alias。

### 3.3 Active Conversation

Active Conversation 作用域：

```text
channel
+ channelAccountId
+ channelConversationId / peerId
```

例如同一个微信账号对不同联系人，Active Conversation 独立。

状态结构：

```ts
interface ActiveConversation {
  channel: string;
  channelAccountId: string;
  peerId: string;
  conversationAlias: string;
  sourceConversationId: string;
  updatedAt: string;
  updatedBy: "explicit_switch" | "reply_reference" | "admin";
}
```

禁止：

```text
outbound push → 自动修改 Active Conversation
```

允许：

```text
用户明确切换 → 修改
用户引用可交互消息并发送 → 可修改
Admin 手动设为当前 → 修改
```

---

## 4. 统一 MessageEnvelope

所有渠道消息、Agent Push、Codex Reply、系统通知统一进入 MessageEnvelope。

```ts
interface MessageEnvelope {
  messageId: string;
  direction: "inbound" | "outbound";

  channel: "qq" | "weixin" | "feishu" | string;
  channelAccountId: string;
  channelConversationId: string;
  channelMessageId?: string;

  source: SourceIdentity;

  replyToChannelMessageId?: string;
  replyToGatewayMessageId?: string;
  correlationId?: string;

  content: unknown;
  createdAt: string;
}
```

所有 Sender / Formatter 不允许丢失 `source` 与 correlation 信息。

---

## 5. Channel Message Registry

新增持久化 `ChannelMessageRegistry`，用于把渠道平台自己的 messageId 映射回 Gateway / Source Conversation。

建议记录：

```text
channel
channel_account_id
peer_id
channel_message_id
gateway_message_id
provider
source_conversation_id
conversation_alias
task_id
capability
created_at
```

核心用途：

- 引用回复解析；
- Approval 关联；
- 消息来源追踪；
- 重试与去重；
- Task Timeline；
- Diagnostics。

不得仅以内存 Map 实现。

---

## 6. ConversationResolver

新增应用层服务：

```ts
interface ConversationResolver {
  resolveInboundTarget(input: ResolveInboundInput): Promise<ResolvedTarget>;
  setActiveConversation(input: SetActiveConversationInput): Promise<void>;
  listRecentConversations(input: ListRecentConversationsInput): Promise<ConversationSummary[]>;
}
```

### 6.1 解析优先级

```text
Inbound Message
      ↓
有 reply-to？
 ├─ 是 → ChannelMessageRegistry
 │       ↓
 │   找到 source
 │       ↓
 │   interactive ?
 │      ├─ yes → 对应 Conversation
 │      └─ no  → 返回 push_only 提示
 │
 └─ 否
      ↓
命中显式 Alias / switch？
 ├─ 是 → 对应 Conversation
 └─ 否
      ↓
存在 Active Conversation？
 ├─ 是 → Active
 └─ 否 → 进入 Router / Clarify
```

### 6.2 与 Intelligent Router 的顺序

建议入站主链：

```text
Channel Adapter
      ↓
Inbound Gateway
      ↓
Deterministic Command Parser
      ↓
Conversation Context Resolver
      ↓
Inbound Intelligent Router
      ↓
Application Service
```

Router 可以识别：

```text
conversation.switch
conversation.list
conversation.current
```

但 Router 不得自己直接修改持久化状态；最终必须调用 ConversationService / Resolver。

---

## 7. 用户可见消息格式

### 7.1 普通 Agent 消息

推荐最小格式：

```text
【Codex · admin-refactor】
订单详情页重构完成。
测试 28/28 通过。

#C7K2
```

另一条：

```text
【Claude · Code Review】
发现 auth.ts 可能存在竞态条件。

#A4M8
```

### 7.2 显示规则

优先级：

```text
Provider
→ Task Title / Project Name
→ Alias
```

禁止默认显示：

- 完整 threadId；
- turnId；
- transport；
- internal space id；
- runtime instance UUID。

技术字段仅在 Admin / Diagnostics 展开。

### 7.3 系统消息

Approval：

```text
【OmniAgent · Approval】
Codex · admin-refactor (#C7K2)
请求执行：pnpm test

/approve
/decline
```

Setup：

```text
【OmniAgent · Setup】
微信登录二维码已过期，需要重新生成。
```

---

## 8. 用户切换 Conversation

### 8.1 自然语言

Router 至少应理解：

- `切到 PageMind 那个任务`
- `回到订单项目`
- `继续刚才 Codex 那个`
- `切到 #C9P1`
- `当前我在跟哪个线程说话？`

### 8.2 确定性命令

必须提供不依赖模型的兜底命令：

```text
/sessions
/current
/use C9P1
```

`/sessions` 示例：

```text
当前可用会话

● #C7K2
  Codex · admin-refactor
  订单详情页重构
  3 分钟前

  #C9P1
  Codex · PageMind
  录制回放修复
  8 分钟前

  #A4M8
  Claude · Code Review
  12 分钟前 · 仅推送
```

### 8.3 切换成功反馈

```text
已切换到：
Codex · PageMind
#C9P1
```

之后无引用普通消息默认进入 #C9P1。

---

## 9. 多个 Codex Thread 同时发消息

场景：

```text
#C7K2 → 订单项目完成
#C9P1 → PageMind 测试失败
```

如果当前 Active = #C7K2，则 #C9P1 的 outbound notification 不得改变 Active。

用户随后直接发送：

```text
再检查一下移动端
```

必须进入 #C7K2。

如果用户引用 #C9P1 的渠道消息回复：

```text
再跑一次
```

则进入 #C9P1，并可将 Active 更新为 #C9P1。

---

## 10. Claude / OpenCode / 其他 MCP Host Push

### 10.1 v0.3 能力边界

v0.3 中：

- Codex Conversation：`interactive`；
- Claude / OpenCode MCP Push：默认 `push_only`；
- MCP Host 可以提供来源 metadata，但不能因此自动变成渠道执行 Agent。

### 10.2 Push Tool 扩展

`push_message` / `push_task_report` 建议增加可选 metadata：

```ts
{
  source: {
    provider: "claude",
    instanceId: "...",
    conversationId: "...",
    taskTitle: "Code Review",
    projectName: "admin-refactor"
  }
}
```

Gateway 负责：

- 分配 / 复用 Alias；
- 写 ChannelMessageRegistry；
- 格式化来源头；
- 标记 `push_only`。

### 10.3 用户引用 push_only 消息

不得假装已经建立双向 Agent Session。

应明确返回：

```text
这条消息来自 Claude Code 的主动推送（#A4M8）。
当前 v0.3 不能从该渠道直接继续这个 Claude 会话。
你可以切换到一个 Codex 会话，或在 Claude Code 中继续该任务。
```

未来若某 Provider 实现正式双向 AgentPort，再将 capability 升级为 `interactive`。

---

## 11. Router 与回复路由的职责边界

### ConversationResolver 负责

- reply-to 映射；
- Alias 解析；
- Active Conversation；
- 是否 interactive；
- 目标 Conversation 的确定性解析。

### Intelligent Router 负责

- `conversation / control / setup / approval / unknown` 意图；
- 自然语言 `conversation.switch`；
- 澄清；
- 置信度决策。

### Orchestrator / Application Service 负责

- 真正执行 thread resume / turn start；
- Control / Setup / Approval 副作用；
- 持久化业务状态。

禁止 Router 直接调用 Codex 或修改 DB。

---

## 12. Admin 原型补充

### 12.1 Task / Conversation 列表

每条至少显示：

```text
Codex · admin-refactor
订单详情页重构
#C7K2
来源：微信
状态：进行中
```

### 12.2 Conversation Detail

增加：

- Provider；
- Alias；
- Internal Conversation ID（高级信息）；
- Active in Channels；
- capability；
- 最近渠道消息；
- 关联 Task。

### 12.3 渠道会话状态

渠道详情可查看：

```text
当前默认会话
Codex · admin-refactor · #C7K2

[切换]
```

### 12.4 Source 标签

Task Timeline 中所有事件必须可追溯 Source，例如：

```text
21:21 微信 → #C7K2 用户消息
21:22 #C7K2 → 微信 Codex 回复
21:23 Claude #A4M8 → 微信 主动 Push
```

---

## 13. 持久化建议

至少新增或扩展以下表：

### conversation_aliases

```text
alias
provider
instance_id
source_conversation_id
project_id
project_name
task_id
task_title
capability
created_at
updated_at
```

### channel_message_registry

```text
channel
channel_account_id
peer_id
channel_message_id
gateway_message_id
source_alias
source_conversation_id
direction
created_at
```

### active_conversations

```text
channel
channel_account_id
peer_id
source_alias
source_conversation_id
updated_by
updated_at
```

唯一约束必须避免同一个 channel/account/peer 存在多个 Active。

---

## 14. 失败与边界处理

### reply-to 找不到映射

不得猜目标：

```text
我无法确认你引用的消息属于哪个任务。
请发送 /sessions 选择目标会话。
```

### Active Conversation 已结束

若 Thread 仍可 resume，可继续；否则提示选择其他会话，不得静默创建不相关 Thread。

### Alias 不存在

```text
没有找到 #C9P1。发送 /sessions 查看最近会话。
```

### 多个自然语言目标同名

例如两个任务都叫“订单问题”，Router 必须澄清并列出 Alias。

### Channel 不支持引用消息

完全依赖 Alias + Active Conversation，不降低来源显示要求。

---

## 15. 安全规则

- Alias 只用于路由定位，不作为授权凭证；
- 用户只能切换到当前 Channel/Peer 有权限访问的 Conversation；
- 不允许通过猜 Alias 跨用户访问其他会话；
- Resolver 查询必须包含 channel identity / peer scope；
- Push-only Provider 不得被 Router 自动升级为 interactive；
- Source metadata 属于不可信输入，MCP Host 提交后必须由 Gateway 校验和归一化。

---

## 16. 可直接执行的开发任务

### SR-01 SourceIdentity / MessageEnvelope Domain

- 定义统一类型；
- 改造 Push / Channel outbound 传递 source metadata；
- 单测所有 Provider 映射。

### SR-02 Conversation Alias Service

- Alias 生成；
- 持久化；
- 复用；
- 冲突处理；
- peer scope 权限检查。

### SR-03 ChannelMessageRegistry

- 记录 outbound / inbound platform messageId；
- reply-to lookup；
- crash-safe persistence；
- retention 策略。

### SR-04 ActiveConversation Store

- per channel/account/peer 唯一 Active；
- 显式切换；
- 引用回复更新；
- outbound push 不更新。

### SR-05 ConversationResolver

- reply-to > explicit alias > active > clarify；
- push_only 检测；
- stale conversation handling。

### SR-06 Deterministic Commands

实现：

```text
/sessions
/current
/use <alias>
```

不得依赖 LLM Router。

### SR-07 Router Integration

- `conversation.switch/list/current`；
- 同名目标澄清；
- Router Decision 记录 target alias。

### SR-08 Channel Formatter

QQ / 微信 / 飞书统一来源展示规范，允许各平台适配样式，但信息不能丢失。

### SR-09 MCP Push Source Metadata

扩展 Push Tool schema，兼容旧参数；旧调用自动生成 `system/unknown` 来源，不破坏现有 Host。

### SR-10 Admin UI

- Conversation Alias；
- Source 标签；
- 当前 Active；
- Message trace；
- push_only 状态。

### SR-11 Migration

- 现有 Codex thread binding 自动生成 Alias；
- 旧 transcript 尽可能补 source；
- 无法恢复来源的历史数据标记 `legacy`，不得伪造。

---

## 17. 测试矩阵

必须至少覆盖：

1. 两个 Codex Thread 连续向同一微信联系人发消息，Active 不被 outbound 改写；
2. 用户无引用回复时进入当前 Active；
3. 用户引用另一 Thread 消息时正确进入被引用 Thread；
4. `/use C9P1` 后普通消息进入 C9P1；
5. Router 故障时 `/sessions` `/use` 仍可用；
6. Claude Push 带来源标签且不改变 Active；
7. 引用 Claude push_only 消息时不错误发送到 Codex 或假装继续 Claude；
8. 两个渠道对同一 Codex Thread 的 Active 状态互不污染；
9. 两个用户猜相同 Alias 时不能越权读取会话；
10. Runtime 重启后 Alias / Registry / Active 恢复；
11. Channel 不支持 reply-to 时 Alias + Active 路径完整可用；
12. Legacy thread migration 后生成稳定 Alias。

---

## 18. P0 验收链路

### E2E-A：多 Codex Thread

```text
Codex Thread A → 微信：消息 + #C7K2
Codex Thread B → 微信：消息 + #C9P1
Active 保持 #C7K2
用户：继续检查移动端
→ #C7K2
```

### E2E-B：引用回复

```text
用户引用 #C9P1 的消息
→ “再跑一次”
→ Resolver 找到 #C9P1
→ Codex thread/resume
→ turn/start
→ Active 更新 #C9P1
```

### E2E-C：多 Agent Push

```text
Claude MCP → 微信 Push #A4M8
→ 标记 Claude · Code Review
→ Active 不变化
用户引用 #A4M8
→ Gateway 返回 push_only 能力说明
→ 不误投到 Codex
```

### E2E-D：显式切换

```text
/use C7K2
→ Active = C7K2
/current
→ Codex · admin-refactor · #C7K2
```

---

## 19. Definition of Done

- [ ] 所有 outbound 用户消息都能识别来源；
- [ ] Codex Thread 有稳定 Conversation Alias；
- [ ] 多 Thread Push 不会偷换 Active Conversation；
- [ ] 支持 reply-to 精确回到对应 Codex Thread；
- [ ] 无 reply-to 时按 Active Conversation 路由；
- [ ] `/sessions` `/current` `/use` 可在 Router 故障时工作；
- [ ] Claude / OpenCode Push 明确标识为 push_only；
- [ ] push_only 引用不会误路由；
- [ ] Alias / Registry / Active 全部持久化；
- [ ] Runtime 重启后路由上下文可恢复；
- [ ] Admin 可查看来源和当前 Active；
- [ ] 不暴露内部 Thread UUID 作为普通用户主交互标识；
- [ ] 所有 Resolver 查询受 Channel/Peer 权限作用域约束。

在以上条件未满足前，v0.3 不应视为已经解决“多 Thread / 多 Agent 共用同一渠道”的产品体验问题。
