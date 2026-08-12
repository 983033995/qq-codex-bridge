# v0.3 原型与交互链路

## 1. 原型目标

本原型说明不设计新的远程聊天端。用户的实际对话仍发生在 QQ、微信、飞书；MCP 只负责 AI 驱动的初始化、管理、诊断与任务控制；Control UI 负责可视化管理。

## 2. 核心角色

- 用户：在 AI Agent 中配置和管理 Bridge，在 QQ/微信/飞书中日常使用。
- AI Agent：Codex / Claude / OpenCode 等 MCP Host。
- MCP：AI Control Plane。
- Runtime：Bridge 常驻服务。
- Channel：QQ / 微信 / 飞书。
- Codex：通过 AppServer 执行任务。

---

## 3. 首次使用主链路

### 3.1 用户添加 MCP

推荐配置：

```json
{
  "mcpServers": {
    "qq-codex-bridge": {
      "command": "npx",
      "args": ["-y", "qq-codex-bridge@latest", "mcp"]
    }
  }
}
```

### 3.2 MCP 启动

```text
MCP process
  ↓
ensureRuntime()
  ↓
检查 runtime.lock / runtime.json / PID
  ↓
未运行 → 启动 Bridge Runtime
  ↓
等待 /health ready
  ↓
返回 MCP ready
```

### 3.3 AI 首次检查

用户：

> 帮我检查 qq-codex-bridge。

AI 调用：

```text
get_setup_status
```

理想返回：

```json
{
  "runtime": "ready",
  "codex": "ready",
  "channels": {
    "qq": "not_configured",
    "weixin": "not_configured",
    "feishu": "not_configured"
  },
  "suggestedActions": ["connect_weixin", "connect_qq", "connect_feishu"]
}
```

AI 文案：

> qq-codex-bridge 已经运行，Codex 连接正常。当前还没有配置消息渠道。你可以先连接微信、QQ 或飞书。

---

## 4. 微信 Setup 原型

### 4.1 开始

用户：

> 帮我连接微信。

AI 调：

```text
start_setup({ target: "channel", type: "weixin" })
```

返回：

```json
{
  "setupId": "setup_xxx",
  "state": "waiting_scan",
  "artifacts": [
    {
      "type": "qr_code",
      "purpose": "login",
      "content": "...",
      "expiresAt": "..."
    }
  ]
}
```

### 4.2 对话显示

```text
连接微信

请使用微信扫描二维码：

[二维码]

二维码有效期 2 分钟。
```

### 4.3 状态变化

```text
waiting_scan
   ↓
scanned
   ↓
confirming
   ↓
connected
```

AI 根据 `get_setup_progress` 输出：

- scanned：`已扫码，请在手机上确认登录。`
- confirming：`正在确认账号状态。`
- connected：`微信已经连接成功。`

### 4.4 过期

如果二维码过期：

```text
二维码已过期。

需要我重新生成吗？
```

重新调用 `start_setup(... force=true)`。

### 4.5 成功后建议

```text
微信已经连接成功。

状态：在线

你现在可以直接在微信里给这个账号发送一条消息测试 Codex。
```

---

## 5. QQ Setup 原型

### 5.1 开始

用户：

> 帮我连接 QQ。

MCP 返回：

```json
{
  "setupId": "setup_qq_xxx",
  "state": "needs_input",
  "artifacts": [
    {
      "type": "form",
      "fields": [
        { "key": "appId", "label": "QQ Bot AppID", "secret": false, "required": true },
        { "key": "clientSecret", "label": "QQ Bot ClientSecret", "secret": true, "required": true }
      ]
    }
  ]
}
```

### 5.2 对话交互

AI：

> 连接 QQ Bot 需要 AppID 和 ClientSecret。如果你已经创建了 Bot，请先把 AppID 发给我。

用户提交 AppID。

AI：

> AppID 已记录。接下来请提供 ClientSecret。

用户提交 Secret。

### 5.3 后台执行

```text
submit_setup
  ↓
字段校验
  ↓
SecretStore.set()
  ↓
写入 Channel Config + secretRef
  ↓
启动 QQ Channel
  ↓
test_channel
```

### 5.4 错误状态

ClientSecret 错误：

```text
QQ 连接失败。

AppID 可以识别，但 ClientSecret 验证失败。请检查后重新提交。
```

不得回显 Secret。

### 5.5 成功

```text
QQ 已连接成功。

Bot：xxx
状态：在线
```

---

## 6. 飞书 Setup 原型

与 QQ 保持一致的交互范式。

字段：

- App ID
- App Secret

成功状态：

```text
飞书连接成功。

长连接：正常
消息接收：正常
消息发送：正常
```

---

## 7. AI 驱动的异常修复流程

### 7.1 用户直接要求使用未配置渠道

用户：

> 发一条消息到微信。

MCP 返回：

```json
{
  "code": "CHANNEL_NOT_CONFIGURED",
  "channel": "weixin",
  "setupAvailable": true
}
```

AI：

> 微信还没有连接。我可以现在帮你完成扫码连接。

### 7.2 Runtime 不存在

任何 MCP 工具调用前先 `ensureRuntime()`。

若启动失败：

```text
qq-codex-bridge 无法启动。

检测结果：Codex App 未找到。

需要我运行完整诊断吗？
```

### 7.3 Setup 被中断

MCP 重启后发现未完成 Setup：

```text
发现一个尚未完成的微信登录流程，但二维码已经过期。需要重新生成吗？
```

---

## 8. Approval 原型

### 8.1 渠道内

Codex 请求执行命令：

```text
Codex 等待你的确认

任务：重构订单详情页

请求执行：
pnpm test

原因：验证本次修改是否通过测试

回复：
/approve
或
/decline
```

对于支持卡片的平台，可升级为按钮，但 v0.3 以文本命令作为统一最低能力。

### 8.2 Admin 首页

```text
┌──────────────────────────────────────┐
│ 需要处理                             │
│                                      │
│ ⚠ Codex 等待确认                     │
│ 重构订单详情页                       │
│ pnpm test                            │
│                                      │
│ [拒绝]                       [允许] │
└──────────────────────────────────────┘
```

### 8.3 已处理

审批一旦 resolved，所有渠道和 Admin 必须同步显示已处理状态，重复点击不可再次执行。

---

## 9. Admin 信息架构

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

## 10. 首页原型

```text
┌────────────────────────────────────────────┐
│ QQ Codex Bridge                    ● 正常 │
│ Codex AppServer · 本机运行                 │
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
  正在执行 · 42 秒

渠道
────────────────────────────────────────────
微信      ● 在线
QQ        ● 在线
飞书      ○ 未配置
```

首页以行动项为中心，不以组件数量和内部 Revision 为中心。

---

## 11. 渠道页原型

```text
渠道

通过 QQ、微信和飞书与 Codex 交互。

┌──────────────────────────────────────┐
│ 微信                           ● 在线 │
│ 默认账号                              │
│ 最后收到消息：2 分钟前                │
│ [测试] [重新登录] [更多]              │
└──────────────────────────────────────┘

┌──────────────────────────────────────┐
│ QQ                             ● 在线 │
│ My Codex Bot                          │
│ [测试] [编辑配置] [更多]              │
└──────────────────────────────────────┘

┌──────────────────────────────────────┐
│ 飞书                           未配置  │
│ [连接飞书]                           │
└──────────────────────────────────────┘
```

Admin 里的“连接渠道”调用同一个 Setup Service。

---

## 12. 任务列表原型

```text
任务

[全部] [进行中] [等待确认] [已完成] [失败]

● 重构订单详情页
  admin-refactor
  来源：微信
  状态：正在运行
  已运行：01:42

⚠ 更新数据库结构
  来源：飞书
  状态：等待确认
  [查看]
```

列表不将 Thread ID / Turn ID / Transport 作为第一信息层。

---

## 13. Task Detail 原型

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
21:21  Codex 开始分析项目
21:22  读取 12 个文件
21:22  修改 src/pages/order/detail.tsx
21:23  请求执行 pnpm test
21:23  用户允许
21:24  测试通过
21:24  完成
```

技术字段保留，但不抢占任务语义。

---

## 14. MCP 页面原型

```text
MCP

状态                     ● 可用
Runtime 自动拉起          ✓

最近 Host
Codex                     2 分钟前
Claude Code               1 小时前

推荐配置
[配置代码块]
[复制]
```

---

## 15. Runtime 页面原型

```text
Runtime

Bridge Runtime        ● Ready
Codex AppServer       ● Ready
CDP Recovery          ● Available
SQLite                ● Ready

PID                   18271
运行时间              14h 22m
版本                   0.3.0

[重启 Runtime] [运行诊断]
```

---

## 16. Diagnostics 原型原则

先解释，再给日志。

```text
⚠ 微信登录已失效

原因
登录凭据已经过期。

建议操作
[重新扫码]

▼ 展开技术信息
```

---

## 17. 原型验收链路

v0.3 至少完成以下 5 条端到端原型链路：

1. `添加 MCP -> 自动启动 Runtime -> 微信扫码 -> 微信消息进入 Codex -> 回复微信`
2. `添加 MCP -> QQ 凭据配置 -> QQ Channel ready -> QQ 消息进入 Codex`
3. `Codex Approval -> 渠道通知 -> 用户 approve -> Codex 继续 -> 状态同步`
4. `单 Session AppServer pre-submit failure -> CDP fallback -> 其他 Session 仍使用 AppServer`
5. `Bridge 在 Turn 中途重启 -> Ledger 恢复 -> 不产生明显重复最终回复`
