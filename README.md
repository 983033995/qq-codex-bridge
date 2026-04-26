# qq-codex-bridge

![CI](https://github.com/983033995/qq-codex-bridge/actions/workflows/ci.yml/badge.svg)
[![License](https://img.shields.io/github/license/983033995/qq-codex-bridge)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)

![qq-codex-bridge README Hero](./output/readme-hero-nanobanana-productized-v1.png)

## 把 Codex / ChatGPT Desktop 变成你的 QQ / 微信私人 AI 助理

**qq-codex-bridge** 是一个开源本地桥接工具，让你通过 **QQ** 或**微信**直接对话 **Codex Desktop** 或 **ChatGPT Desktop**——支持图片理解、语音提问、文件分析、AI 生图回传，私聊群聊都能用，同时支持多 Bot、多账号接入。

---

## 你可以这样用

### 发张图片，让 AI 帮你看

遇到截图、照片、产品图？直接发给机器人，AI 会结合图片内容给出分析。手机端 QQ、桌面端 QQ 均可使用。

![图片理解](./output/截屏%202026-04-10%2021.33.09.png)

### 语音提问，张口就来

发一条语音，桥接会自动转写后发给 AI。双手不便打字时，直接说话就能问。

### Markdown 和代码，结构完整回传

AI 输出的列表、代码块、表格会尽量保留格式后再发到 QQ。写代码、看文档都清晰。

![Markdown 渲染效果](./output/截屏%202026-04-10%2021.31.46.png)

### AI 生成了图片？直接发回 QQ

Codex / ChatGPT 调用图片生成工具后，成品会自动回传到 QQ 对话里。创作结果一目了然。

![AI 生图回传](./output/截屏%202026-04-10%2022.00.25.png)

### 私聊线程管理，复杂任务不丢上下文

在 QQ 私聊中直接查看、切换、新建 Codex / ChatGPT 对话线程。大型项目可以分线程讨论，每个线程独立记忆，互不干扰。

![线程管理](./output/截屏%202026-04-10%2021.47.08.png)

---

## 工作原理

```text
QQ Bot / 微信
      │
      ▼
BridgeOrchestrator（本地 Node.js 进程）
      │
      ├── SessionStore / TranscriptStore（SQLite）
      ├── Channel Sender（QQ / 微信）
      │
      ├── CodexDesktopDriver ──► Chrome DevTools Protocol ──► Codex Desktop
      └── ChatgptDesktopDriver ──► macOS Accessibility API ──► ChatGPT Desktop
```

桥接运行在本地，通过 CDP 驱动 Codex Desktop，通过 macOS Accessibility API 驱动 ChatGPT Desktop，完成消息收发和上下文注入。每个私聊会话可以独立绑定对话线程，并通过 `/source` 命令随时切换 AI 源。

---

## 快速开始

### 第 0 步：创建 QQ 机器人，获取 AppID 和 AppSecret

1. 打开 [QQ 开放平台](https://q.qq.com/qqbot/openclaw/index.html)，登录后点击「**创建机器人**」
2. 填写机器人名称和简介，完成创建
3. 进入机器人详情页，复制 **AppID** 和 **AppSecret**（点击"查看"可显示 AppSecret）

![QQ 开放平台机器人创建页面](https://minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com/ccv2%2F2026-04-13%2FMiniMax-M2.7%2F2022349168671990452%2F7e608ce17a900fa601a014dc957ef1314be87cff5a110e27615a5393bf2912d6..png?Expires=1776145198&OSSAccessKeyId=LTAI5tGLnRTkBjLuYPjNcKQ8&Signature=eM71QgFWMmELUyeGG2fLn3Onugk%3D)

> 同一 AppID + AppSecret 可以同时在多个群聊和私聊中使用，无需重复创建。

### 第 1 步：生成配置文件

推荐直接用 `npx`：

```bash
npx qq-codex-bridge init
```

或全局安装后使用：

```bash
npm i -g qq-codex-bridge
qq-codex-bridge init
```

这会将内置配置模板写入当前目录的 `.env`。

### 第 2 步：填写 `.env`

将上一步复制的 **AppID** 和 **AppSecret** 填入 `.env`：

```env
QQBOT_APP_ID=你的AppID
QQBOT_CLIENT_SECRET=你的ClientSecret
```

`.env` 中其他常用变量：

| 变量 | 说明 | 默认值 |
|---|---|---|
| `CODEX_REMOTE_DEBUGGING_PORT` | Codex Desktop 远程调试端口 | `9229` |
| `QQBOT_STT_*` | 语音转文字配置（可选，不填则用 QQ 内置 ASR） | — |
| `QQBOT_MARKDOWN_SUPPORT` | 是否启用 QQ markdown 文本发送 | `false` |

### 第 3 步：启动桥接

```bash
npx qq-codex-bridge
```

正常启动后会看到类似日志：

```text
[qq-codex-bridge] codex desktop ready { launched: true|false, remoteDebuggingPort: 9229 }
[qq-codex-bridge] ready { transport: 'qq-gateway-websocket', accountKeys: ['qqbot:default'], conversationProvider: 'codex-desktop' }
```

> 桥接会先检查 Codex Desktop 是否已运行；若未运行，会尽量自动拉起后再继续。

### 第 4 步：在 QQ 中联调

建议按这个顺序测试：

1. **普通文本** — 先确认消息收发正常
2. **一条会让 AI 分阶段回答的问题** — 验证增量回复采集
3. **一条语音** — 验证 STT 转写链路
4. **一张图片** — 验证图片上下文注入
5. **`/t` 与 `/tu 2`** — 验证线程管理命令

---

## 微信通道

仓库内置了一套**真实微信文本网关**，对接微信 long-poll 接口，把消息转发给 bridge，再把回复发回微信。

### 最小配置

在 `.env` 中补充：

```env
WEIXIN_ENABLED=true
WEIXIN_ACCOUNT_ID=default
WEIXIN_WEBHOOK_PATH=/webhooks/weixin
WEIXIN_EGRESS_BASE_URL=http://127.0.0.1:3200
WEIXIN_EGRESS_TOKEN=your-token
```

### 首次扫码登录

```bash
pnpm weixin:login
# 或已安装发布包：
qq-codex-weixin-gateway --weixin-login
```

### 启动网关

```bash
# 源码开发模式（同时启动 bridge + 微信网关）：
pnpm dev

# 或单独启动微信网关：
pnpm start:weixin-gateway
# 已安装发布包：
qq-codex-weixin-gateway
```

完整说明见：[微信文本通道接入文档](./docs/weixin-text-gateway.md)

---

## 多 Bot / 多账号接入

### 多 QQ Bot

**方式 A：JSON 数组（推荐）**

```env
QQBOTS_JSON=[{"accountId":"main","appId":"AppID1","clientSecret":"Secret1","markdownSupport":false},{"accountId":"shop","appId":"AppID2","clientSecret":"Secret2","markdownSupport":false}]
```

**方式 B：ID 列表 + 分账号变量**

```env
QQBOT_ACCOUNT_IDS=main,shop
QQBOT_MAIN_APP_ID=AppID1
QQBOT_MAIN_CLIENT_SECRET=Secret1
QQBOT_SHOP_APP_ID=AppID2
QQBOT_SHOP_CLIENT_SECRET=Secret2
```

### 多微信账号

每个微信账号需要一个独立的网关进程（监听不同端口）：

**方式 A：JSON 数组**

```env
WEIXIN_ACCOUNTS_JSON=[{"accountId":"main","webhookPath":"/webhooks/weixin/main","egressBaseUrl":"http://127.0.0.1:3201","egressToken":"token-main"},{"accountId":"shop","webhookPath":"/webhooks/weixin/shop","egressBaseUrl":"http://127.0.0.1:3202","egressToken":"token-shop"}]
```

**方式 B：ID 列表 + 分账号变量**

```env
WEIXIN_ACCOUNT_IDS=main,shop
WEIXIN_MAIN_WEBHOOK_PATH=/webhooks/weixin/main
WEIXIN_MAIN_EGRESS_BASE_URL=http://127.0.0.1:3201
WEIXIN_MAIN_EGRESS_TOKEN=token-main
WEIXIN_SHOP_WEBHOOK_PATH=/webhooks/weixin/shop
WEIXIN_SHOP_EGRESS_BASE_URL=http://127.0.0.1:3202
WEIXIN_SHOP_EGRESS_TOKEN=token-shop
```

> 单 bot 单账号时保持旧配置（`QQBOT_APP_ID` + `QQBOT_CLIENT_SECRET`）即可，自动作为 `accountId=default` 处理，无需改动。

---

## 对话源切换（Codex / ChatGPT）

bridge 同时支持 **Codex Desktop** 和 **ChatGPT Desktop** 作为 AI 对话后端。每个私聊会话可以独立切换：

```text
/source          查看当前对话源
/source codex    切换到 Codex Desktop
/source chatgpt  切换到 ChatGPT Desktop
```

切换后，`/t`、`/tu`、`/tn` 等线程命令会自动路由到对应的 Desktop 应用。

---

## 开发者源码启动

```bash
git clone https://github.com/983033995/qq-codex-bridge.git
cd qq-codex-bridge
pnpm install
cp .env.example .env
# 填写 .env 中的 QQBOT_APP_ID 和 QQBOT_CLIENT_SECRET
pnpm dev
```

---

## 项目特性

### 核心能力

- QQ 官方 Bot WebSocket gateway 入站，支持多 bot 并行
- 微信文本 long-poll 入站 / HTTP 文本出站，支持多账号
- QQ 私聊 / 群聊会话隔离
- 多通道会话隔离（QQ / 微信）
- 双 AI 源：Codex Desktop（CDP）+ ChatGPT Desktop（macOS AX）
- 每个私聊会话独立绑定线程，可随时切换 AI 源
- SQLite 持久化会话、入站记录、出站任务

### 媒体与语音

- QQ 附件下载与上下文注入（图片、语音、视频、文件）
- 语音转文字：支持 QQ 内置 ASR / OpenAI 兼容 / 火山引擎 / 本地 whisper.cpp
- QQ 媒体回传：图片、音频、视频、文件
- ChatGPT Desktop 图片生成结果自动回传

### 回复处理

- 富文本链接提取、有序列表编号保留
- 代码块序列化为 fenced markdown、表格结构保留
- 长耗时任务回复采集窗口延长
- 同一轮回复中的媒体结果持续跟进

### 私聊命令（完整列表）

所有命令仅在**私聊**中有效；`/` 开头的命令由 bridge 拦截处理，不会直接发给 AI。

**Codex Desktop 源下可用：**

| 用途 | 完整命令 | 简写 |
| --- | --- | --- |
| 查看最近活跃线程 | `/threads` | `/t` |
| 查看当前绑定线程 | `/thread current` | `/tc` |
| 切换到指定线程 | `/thread use <序号>` | `/tu <序号>` |
| 新建线程 | `/thread new <标题>` | `/tn <标题>` |
| 基于最近对话 fork 线程 | `/thread fork <标题>` | `/tf <标题>` |
| 查看当前模型 | `/model` | `/m` |
| 切换模型 | `/model use <名称>` | `/mu <名称>` |
| 查看额度信息 | `/quota` | `/q` |
| 查看当前运行状态 | `/status` | `/st` |

**ChatGPT Desktop 源下可用：**

| 用途 | 完整命令 | 简写 |
| --- | --- | --- |
| 查看最近对话列表 | `/threads` | `/t` |
| 查看当前绑定对话 | `/thread current` | `/tc` |
| 切换到指定对话 | `/thread use <序号>` | `/tu <序号>` |
| 新建对话 | `/thread new <标题>` | `/tn <标题>` |

**两种源通用：**

| 用途 | 命令 |
| --- | --- |
| 查看当前对话源 | `/source` |
| 切换到 Codex Desktop | `/source codex` |
| 切换到 ChatGPT Desktop | `/source chatgpt` |
| 查看所有已接入账号 | `/accounts` |
| 查看帮助 | `/help` 或 `/h` |

---

## 当前实现上的保护逻辑

- **重复 QQ 入站抑制** — 短时间内同一会话、同一正文、同一媒体指纹的重复消息会被拦下
- **长耗时任务回复采集窗口延长** — 图片生成、长搜索不再因默认超时被提前截断
- **单条 draft 发送失败不再截断整轮回复** — 某一条 QQ 发送失败时，后续 draft 仍会继续尝试
- **可恢复错误不会打断桥接** — `reply_timeout` 等可恢复错误不再直接把会话打成 `needs_rebind`

---

## 已知限制

- Codex Desktop 驱动依赖当前版本的 DOM 结构和 CDP 可见性，桌面端改版后可能需要跟着适配
- ChatGPT Desktop 驱动依赖 macOS Accessibility API，macOS 系统权限变更可能影响使用
- 对 AI 回复的增量采集是**基于页面快照的伪流式**，不是官方内部事件流
- QQ 客户端的消息样式、Markdown 支持、媒体卡片展示不完全可控
- 微信当前只开放了**文本通道**，还没有内置图片、语音、文件与真实提供方签名适配
- 线程管理命令目前只在 **QQ 私聊** 中开放

---

## 环境要求

- macOS
- Node.js 20+
- 已安装 Codex Desktop（使用 Codex 源时）
- 已安装 ChatGPT Desktop（使用 ChatGPT 源时）
- QQ 官方机器人 `AppID` 和 `ClientSecret`

---

## 安全提醒

- `.env` 里包含 QQ Bot、STT 等敏感密钥，**不要提交到仓库**（`.gitignore` 已默认排除 `.env`）
- 如果你把项目分享给别人，请务必轮换已经暴露过的密钥
- 本项目会处理用户消息、附件、语音与本地文件路径，联调时请注意隐私边界

---

## 调试建议

```bash
# 类型检查
pnpm run check

# 运行测试
pnpm test

# 调试 Codex page / worker
pnpm run debug:codex-workers -- --duration-ms 12000
```

---

## 文档导航

- [FAQ 与故障排查](./docs/faq.md)
- [架构说明](./docs/architecture.md)
- [测试说明](./docs/testing.md)
- [变更记录](./CHANGELOG.md)
- [贡献指南](./CONTRIBUTING.md)
- [安全策略](./SECURITY.md)
- [在线 Wiki（GitNexus 自动生成）](https://gistcdn.githack.com/983033995/e5715ad0d61605f039ca4e6055094083/raw/index.html#overview)

---

## 贡献

欢迎 issue、讨论和 PR。在提交改动前，建议至少执行：

```bash
pnpm run check
pnpm test
```

更多约定请看 [CONTRIBUTING.md](./CONTRIBUTING.md) 和 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。

---

## License

本仓库使用 [MIT License](./LICENSE)。
