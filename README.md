# qq-codex-bridge

![CI](https://github.com/983033995/qq-codex-bridge/actions/workflows/ci.yml/badge.svg)
[![License](https://img.shields.io/github/license/983033995/qq-codex-bridge)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)

![qq-codex-bridge README Hero](./output/readme-hero-nanobanana-productized-v1.png)

## 把 Codex Desktop 变成你的 QQ 私人 AI 助理

不想在浏览器和 QQ 之间来回切换？想把 Codex 的强大能力直接搬到你的 QQ 好友列表和群聊里？

**qq-codex-bridge** 是一个开源桥接工具，它让 Codex Desktop 成为你 QQ 上的实时 AI 对话伙伴——支持图片理解、语音提问、文件分析和 AI 生图回传，私聊群聊都能用。

现在也提供了**实验性的微信文本通道**：
- bridge 已支持微信文本入站/出站 adapter
- 仓库内置了一个**真实微信文本网关 CLI**
- 参考 `qq-codex-runner` 的方式，支持扫码登录、long-poll 拉取和文本回发

---

## 你可以这样用

### 发张图片，让 Codex 帮你看

遇到截图、照片、产品图？直接发给机器人，Codex 会结合图片内容给出分析。手机端 QQ、桌面端 QQ 均可使用。

![图片理解](./output/截屏%202026-04-10%2021.33.09.png)

### 语音提问，张口就来

发一条语音，桥接会自动转写后发给 Codex。双手不便打字时，直接说话就能问 AI。

### Markdown 和代码，结构完整回传

Codex 输出的列表、代码块、表格会尽量保留格式后再发到 QQ。写代码、看文档都清晰。

![Markdown 渲染效果](./output/截屏%202026-04-10%2021.31.46.png)

### AI 生成了图片？直接发回 QQ

Codex 调用图片生成工具后，成品会自动回传到 QQ 对话里。创作结果一目了然。

![AI 生图回传](./output/截屏%202026-04-10%2022.00.25.png)

### 私聊线程管理，复杂任务不丢上下文

在 QQ 私聊中直接查看、切换、新建 Codex 线程。大型项目可以分线程讨论，每个线程独立记忆，互不干扰。

![线程管理](./output/截屏%202026-04-10%2021.47.08.png)

---

## 工作原理

```
QQ 私聊/群聊 ──► 桥接服务 ──► Codex Desktop（CDP 驱动）
                    ▲                      │
                    └────── 回复回传 ───────┘
```

桥接运行在本地 Node.js 进程中，通过 Chrome DevTools Protocol 驱动已运行的 Codex Desktop，完成消息收发和上下文注入。

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

`.env` 中其他变量说明：

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
[qq-codex-bridge] ready { transport: 'qq-gateway-websocket', accountKey: 'qqbot:default' }
```

> 桥接会先检查 Codex Desktop 是否已运行；若未运行，会尽量自动拉起后再继续。

### 第 4 步：在 QQ 中联调

建议按这个顺序测试：

1. **普通文本** — 先确认消息收发正常
2. **一条会让 Codex 分阶段回答的问题** — 验证增量回复采集
3. **一条语音** — 验证 STT 转写链路
4. **一张图片** — 验证图片上下文注入
5. **`/t` 与 `/tu 2`** — 验证线程管理命令

---

## 微信文本通道（实验性）

如果你想先接入微信文本，仓库里已经提供了一套**真实微信文本网关**。它会直接对接微信 long-poll 接口，把收到的文本转发给 bridge，再把 bridge 的回复发回微信。

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
qq-codex-weixin-gateway --weixin-login
```

扫码成功后，再启动网关。

### 启动真实网关

```bash
pnpm dev:weixin-gateway
```

或者在已发布包里使用：

```bash
qq-codex-weixin-gateway
```

完整说明见：

- [微信文本通道接入文档](./docs/weixin-text-gateway.md)

---

## 开发者源码启动

如果你要参与开发、调试源码或运行测试：

```bash
git clone https://github.com/983033995/qq-codex-bridge.git
cd qq-codex-bridge
pnpm install
cp .env.example .env
# 填写 .env 中的 QQBOT_APP_ID 和 QQBOT_CLIENT_SECRET
pnpm dev
```

---

## 技术架构

```text
QQ / 微信 Channel Adapter
          │
          ▼
BridgeOrchestrator
          │
          ├── SessionStore / TranscriptStore (SQLite)
          ├── Channel Sender (QQ / Weixin)
          └── CodexDesktopDriver
                  │
                  └── Chrome DevTools Protocol
                          │
                          └── Codex Desktop
```

---

## 项目特性

### 核心能力

- QQ 官方 Bot WebSocket gateway 入站
- 微信文本 long-poll 入站 / HTTP 文本出站（实验性）
- QQ 私聊 / 群聊会话隔离
- 多通道会话隔离（QQ / 微信）
- Codex Desktop 启动检查与 CDP 连接
- 通道消息映射到 Codex 线程
- Codex 回复增量采集并多次回传到 QQ
- SQLite 持久化会话、入站记录、出站任务

### 媒体与语音

- QQ 附件下载与上下文注入（图片、语音、视频、文件）
- 语音转文字：支持 QQ 内置 ASR / OpenAI 兼容 / 火山引擎 / 本地 whisper.cpp
- QQ 媒体回传：图片、音频、视频、文件

### Codex 回复处理

- 富文本链接提取、有序列表编号保留
- 代码块序列化为 fenced markdown、表格结构保留
- 长耗时任务回复采集窗口延长
- 同一轮回复中的媒体结果持续跟进，不再只截前几段文本

### 线程管理命令

仅私聊可用：

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
| 查看帮助 | `/help` | `/h` |

---

## 当前实现上的保护逻辑

这几个是和"最小 demo"相比的重要工程细节：

- **重复 QQ 入站抑制** — 短时间内同一会话、同一正文、同一媒体指纹的重复消息会被拦下
- **长耗时任务回复采集窗口延长** — 图片生成、长搜索、长工具执行不再因默认 30 秒窗口被提前截断
- **单条 draft 发送失败不再截断整轮回复** — 某一条 QQ 发送失败时，后续 draft 仍会继续尝试
- **可恢复错误不会把整个桥接打成不可用** — 例如 `reply_timeout` 被当成可恢复错误，不再直接把会话打成 `needs_rebind`

---

## 已知限制

- 核心能力依赖 Codex Desktop 当前版本的 DOM 结构和 CDP 可见性，桌面端改版后可能需要跟着适配
- 对 Codex 回复的增量采集是**基于页面快照的伪流式**，不是官方内部事件流
- QQ 客户端的消息样式、Markdown 支持、媒体卡片展示不完全可控
- 微信当前只开放了**文本通道的参考网关**，还没有内置图片、语音、文件与真实提供方签名适配
- 线程管理命令目前只在 **QQ 私聊** 中开放
- 某些极端场景下，如果 Codex Desktop 页面结构变化很大，线程定位与回复提取可能失效

---

## 环境要求

- macOS
- Node.js 20+
- 已安装 Codex Desktop
- Codex Desktop 可通过远程调试端口暴露 page target
- QQ 官方机器人 `AppID` 和 `ClientSecret`

---

## 安全提醒

- `.env` 里会包含 QQ Bot、STT 等敏感密钥，**不要提交到仓库**
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
