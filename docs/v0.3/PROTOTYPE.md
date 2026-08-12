# OmniAgent Gateway v0.3 原型与交互链路

## 1. 原型目标

本原型说明不设计新的远程聊天端。用户的实际对话仍发生在 QQ、微信、飞书；MCP 负责 AI 驱动的初始化、管理、诊断与任务控制；Control UI 负责可视化管理。

所有渠道入站消息必须先进入 **Inbound Intelligent Router**，再决定是普通 Codex 对话、系统控制、渠道配置还是审批。

产品显示名统一为 **OmniAgent Gateway**。

---

## 2. 核心角色

- 用户：在 AI Agent 中配置和管理 OmniAgent Gateway，在 QQ/微信/飞书中日常使用。
- AI Agent：Codex / Claude / OpenCode 等 MCP Host。
- MCP：AI Control Plane。
- Runtime：Gateway 常驻服务。
- Channel：QQ / 微信 / 飞书。
- Router：渠道入站自然语言意图判断与分发。
- Codex：v0.3 的渠道 Conversation 执行 Agent，通过 AppServer 执行任务。

---

## 3. 首次使用主链路

### 3.1 用户添加 MCP

兼容期配置示例：

```json
{
  "mcpServers": {
    "omniagent-gateway": {
      "command": "npx",
      "args": ["-y", "qq-codex-bridge@latest", "mcp"]
    }
  }
}
```

正式发布后目标为 `omniagent-gateway` 包/CLI，旧包名保留兼容。

### 3.2 MCP 启动

```text
MCP process
  ↓
ensureRuntime()
  ↓
检查 lock / runtime.json / PID
  ↓
未运行 → 启动 Gateway Runtime
  ↓
等待 /health ready
  ↓
返回 MCP ready
```

### 3.3 AI 首次检查

用户：

> 帮我检查 OmniAgent Gateway。

AI 调用：`get_setup_status`

理想返回：

```json
{
  "runtime": "ready",
  "codex": "ready",
  "router": "ready",
  "channels": {
    "qq": "not_configured",
    "weixin": "not_configured",
    "feishu": "not_configured"
  }
}
```

---

## 4. 微信 Setup 原型

用户：

> 帮我连接微信。

AI 调：

```text
start_setup({ target: "channel", type: "weixin" })
```

返回 QR Artifact。

状态：

```text
waiting_scan → scanned → confirming → connected
```

成功后 AI：

> 微信已经连接成功。现在可以直接在微信里发消息，OmniAgent Gateway 会先判断你的意图，再决定是让 Codex 执行还是处理系统控制。

---

## 5. QQ Setup 原型

用户：

> 帮我连接 QQ。

MCP 返回 AppID / ClientSecret 表单 Artifact。

流程：

```text
submit_setup
  ↓
字段校验
  ↓
SecretStore.set()
  ↓
Channel Config + secretRef
  ↓
启动 QQ Channel
  ↓
test_channel
```

Secret 不得回显。

---

## 6. 飞书 Setup 原型

与 QQ 一致：App ID + App Secret，完成后自动启动长连接并检查收发能力。

---

## 7. 渠道入站 Router 主链路

### 7.1 普通对话

微信用户：

> 帮我排查一下订单详情页为什么报错。

链路：

```text
微信
 ↓
Inbound Gateway
 ↓
Router
 ↓
kind=conversation
confidence=0.97
 ↓
ConversationService
 ↓
Codex AppServer turn/start
 ↓
结果回微信
```

用户不需要输入任何特殊前缀。

### 7.2 Control 意图

QQ 用户：

> 重启一下微信渠道。

Router：

```json
{
  "kind": "control",
  "action": "channel.restart",
  "target": "weixin",
  "confidence": 0.98,
  "risk": "medium"
}
```

执行：

```text
Router
 ↓
IntentDispatcher
 ↓
ChannelControlService
 ↓
重启微信
 ↓
QQ 返回执行结果
```

该消息不得进入 Codex。

### 7.3 Setup 意图

飞书用户：

> 帮我重新登录微信。

Router：

```text
kind=setup
action=channel.login
target=weixin
```

如果渠道能力允许在当前会话呈现二维码，则直接返回 QR；否则返回清晰说明并引导到 Admin/MCP 对话完成。

### 7.4 Approval 意图

用户：

> 允许刚才那个 pnpm test。

Router：

```text
kind=approval
action=resolve.approve
```

ApprovalService 根据当前 Space/Task 找到唯一 pending approval。

若存在多个候选：

```text
当前有 2 个请求等待确认：
1. pnpm test — 重构订单详情页
2. npm install — 数据迁移任务

请告诉我你要允许哪一个。
```

不得猜测。

---

## 8. Router 置信度原型

### 高置信

> 重启飞书。

```text
confidence=0.98
→ 自动进入 ChannelControlService
```

### 中等置信

> 把微信那个重新弄一下。

```text
confidence=0.72
→ clarify
```

回复：

> 你是想重新登录微信，还是只重启微信连接？

### 低置信

> 帮我看看微信相关代码有没有问题。

```text
confidence=0.31 for control/setup
→ conversation fallback
→ Codex
```

---

## 9. Router Provider 故障原型

Router 模型超时：

```text
InboundMessage
 ↓
Router timeout
 ↓
记录 router.degraded
 ↓
安全 fallback = conversation
 ↓
Codex
```

用户仍然得到正常回答，不显示内部模型异常，除非确实影响执行。

但 `/approve`、`/decline` 等确定性命令仍应通过 deterministic parser 工作。

---

## 10. Approval 原型

Codex 请求执行：

```text
Codex 等待你的确认

任务：重构订单详情页
请求执行：pnpm test
原因：验证本次修改

回复：
/approve
或
/decline
```

自然语言 `允许` / `拒绝` 也可由 Router 识别，但确定性命令是最低保证。

审批一旦 resolved，所有渠道/Admin 状态同步，重复执行返回“已处理”。

---

## 11. Admin 信息架构

```text
首页

渠道
├── QQ
├── 微信
└── 飞书

对话
├── 会话
└── 绑定关系

任务
├── 全部
├── 进行中
├── 等待确认
├── 已完成
└── 失败

自动化
├── 主动推送
└── MCP

智能路由

系统
├── Runtime
├── 配置
├── 日志
└── 诊断
```

不增加 Remote 页面。

---

## 12. 首页原型

```text
┌────────────────────────────────────────────┐
│ OmniAgent Gateway                  ● 正常 │
│ Codex AppServer · Router Ready · 本机运行 │
└────────────────────────────────────────────┘

┌───────────┐ ┌───────────┐ ┌───────────┐
│ 正在运行  │ │ 等待确认  │ │ 在线渠道  │
│     2     │ │     1     │ │   2 / 3   │
└───────────┘ └───────────┘ └───────────┘

需要处理
────────────────────────────────────────────
⚠ Codex 等待确认
重构订单页面
pnpm test
[拒绝]                              [允许]

进行中的任务
────────────────────────────────────────────
● 排查支付页面错误
  微信 · admin-refactor
  Router: Conversation · 97%
  正在执行 · 42 秒

渠道
────────────────────────────────────────────
微信      ● 在线
QQ        ● 在线
飞书      ○ 未配置
```

---

## 13. 智能路由页原型

```text
智能路由                                      ● 正常

模式
( ) 关闭   (●) 辅助   ( ) 自动

决策策略
────────────────────────────────────────────
高置信度 ≥ 90%
自动分流到对应能力

中等置信度 50%–89%
向用户澄清后再执行

低置信度 < 50%
按普通 Codex 对话处理

最近决策
────────────────────────────────────────────
97%  Conversation   微信   “帮我排查订单页...”
98%  Control        QQ     “重启一下微信渠道”
72%  Clarify        飞书   “把微信那个重新弄一下”
31%  Conversation   微信   “看看微信相关代码...”

[高级设置]
```

高级设置：Endpoint / Model / Secret Reference / timeout / thresholds。

---

## 14. 渠道页原型

```text
渠道
通过 QQ、微信和飞书与 Codex 交互；系统控制类消息会由智能路由直接处理。

微信  ● 在线
QQ    ● 在线
飞书  未配置
```

连接/重新登录统一调用 SetupService。

---

## 15. Task Detail 原型

```text
重构订单详情页
admin-refactor
● 正在执行

来源      微信
模型      GPT-5.x
传输      AppServer
Thread    ••••a93c

任务时间线
────────────────────────────────
21:21  收到用户消息
21:21  Router → Conversation · 97%
21:21  Codex 开始分析项目
21:22  读取 12 个文件
21:22  修改 src/pages/order/detail.tsx
21:23  请求执行 pnpm test
21:23  用户允许
21:24  测试通过
21:24  完成
```

---

## 16. MCP 页面原型

```text
MCP
状态                     ● 可用
Runtime 自动拉起          ✓

最近 Host
Codex                     2 分钟前
Claude Code               1 小时前
OpenCode                  3 小时前
```

说明文案必须明确：Claude/OpenCode 在 v0.3 通过 MCP 管理 Gateway、Push 渠道消息，但 QQ/微信/飞书的入站 Conversation 仍由 Codex 执行。

---

## 17. Runtime / Diagnostics

Runtime：Gateway Runtime / Codex AppServer / Router Provider / CDP Recovery / SQLite。

Diagnostics 优先输出“发生了什么、为什么、怎么修复”，技术日志默认折叠。

---

## 18. 原型验收链路

v0.3 至少完成以下 9 条端到端链路：

1. `添加 MCP -> 自动启动 Runtime -> 微信扫码 -> 微信普通消息 -> Router Conversation -> Codex -> 回复微信`
2. `QQ 配置 -> QQ 消息“重启微信” -> Router Control -> 微信重启 -> QQ 返回结果`
3. `飞书消息“帮我重新登录微信” -> Router Setup -> SetupService`
4. `Codex Approval -> 渠道通知 -> 用户自然语言“允许”/命令 /approve -> ApprovalService -> Codex 继续`
5. `Router 中等置信度 -> 澄清 -> 用户补充 -> 正确执行`
6. `Router Provider timeout -> conversation fallback -> 消息不丢失`
7. `单 Session AppServer pre-submit failure -> CDP fallback -> 其他 Session 仍 AppServer`
8. `Runtime Turn 中途重启 -> Ledger 恢复 -> 不明显重复最终回复`
9. `旧 qq-codex-bridge 配置升级 -> OmniAgent Gateway UI/Runtime 正常 -> 旧 CLI 仍可兼容调用`
