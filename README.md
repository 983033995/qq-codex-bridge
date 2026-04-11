# qq-codex-bridge

![CI](https://github.com/983033995/qq-codex-bridge/actions/workflows/ci.yml/badge.svg)
[![License](https://img.shields.io/github/license/983033995/qq-codex-bridge)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)

![qq-codex-bridge README Hero](./output/readme-hero-nanobanana-productized-v1.png)

一个把 **QQ 官方机器人会话** 桥接到 **Codex Desktop** 的开源实验项目。

它的核心目标很直接：

- 在 QQ 私聊 / 群聊里接收用户消息
- 按会话把消息映射到 Codex Desktop 线程
- 用 CDP 驱动 Codex Desktop 发送消息、切线程、读取回复
- 把 Codex 的文本、图片、文件、语音转写结果继续回送到 QQ

项目当前已经能跑真实链路，但仍然属于 **实验性可用** 阶段，更适合开发者联调、研究和二次改造，而不是直接当成稳定生产系统。

## 文档导航

- [快速开始](#快速开始)
- [FAQ 与故障排查](./docs/faq.md)
- [架构说明](./docs/architecture.md)
- [测试说明](./docs/testing.md)
- [变更记录](./CHANGELOG.md)
- [贡献指南](./CONTRIBUTING.md)
- [安全策略](./SECURITY.md)

---

## 项目特性

### 核心链路

- QQ 官方 Bot WebSocket gateway 入站
- QQ 私聊 / 群聊会话隔离
- Codex Desktop 启动检查与 CDP 连接
- QQ 消息映射到 Codex 线程
- Codex 回复增量采集并多次回传到 QQ
- SQLite 持久化会话、入站记录、出站任务

### 媒体与 STT

- QQ 附件下载与上下文注入
  - 图片
  - 语音
  - 视频
  - 文件
- 语音转文字
  - QQ 自带 `asr_refer_text` 回退
  - `openai-compatible`
  - `volcengine-flash`
  - 本地离线 `whisper.cpp`
- QQ 媒体回传
  - 图片
  - 音频
  - 视频
  - 文件

### Codex 回复处理

- 富文本链接提取
- 有序列表编号保留
- 代码块序列化为 fenced markdown
- 表格结构保留
- 长耗时任务回复采集窗口延长
- 同一轮回复中的媒体结果继续跟进，不再只截前几段文本

### 线程管理

仅私聊可用：

| 用途 | 完整命令 | 简写 |
| --- | --- | --- |
| 查看最近活跃线程 | `/threads` | `/t` |
| 查看当前绑定线程 | `/thread current` | `/tc` |
| 切换到指定线程 | `/thread use <序号>` | `/tu <序号>` |
| 新建线程 | `/thread new <标题>` | `/tn <标题>` |
| 基于最近对话 fork 线程 | `/thread fork <标题>` | `/tf <标题>` |
| 查看帮助 | `/help` | - |

---

## 适用场景

- 想直接在 QQ 里把 Codex 当成一个“会话型桌面代理”来用
- 需要把图片、语音、文件上下文桥接给 Codex
- 想研究 Codex Desktop 的 CDP 自动化与回复采集
- 想复用 QQ 官方 Bot 能力，但不依赖 OpenClaw 宿主

---

## 项目效果

### Markdown 与代码回复

Codex 的列表、代码块、表格会尽量保留结构后再发给 QQ。

![Markdown 渲染效果](./output/截屏%202026-04-10%2021.31.46.png)

### 图片理解

发送图片给机器人，Codex 可以结合图片内容继续回答。

![图片理解](./output/截屏%202026-04-10%2021.33.09.png)

### 线程管理

在 QQ 私聊中直接查看最近活跃线程，并快速切换。

![线程管理](./output/截屏%202026-04-10%2021.47.08.png)

### AI 生图回传

Codex 调用图片生成工具后，桥接会把成品图片继续回传到 QQ。

![AI 生图回传](./output/截屏%202026-04-10%2022.00.25.png)

---

## 技术架构

```text
QQ Official Bot Gateway
        │
        ▼
QqGatewayClient / QqGateway
        │
        ▼
BridgeOrchestrator
        │
        ├── SessionStore / TranscriptStore (SQLite)
        ├── QqSender / QqApiClient
        └── CodexDesktopDriver
                │
                └── Chrome DevTools Protocol
                        │
                        └── Codex Desktop
```

更贴近实际运行时的链路是：

```text
QQ 消息
  -> 归一化 / 附件下载 / STT
  -> 构造成 Codex 入站上下文
  -> 注入 Codex Desktop
  -> 轮询最新 assistant unit
  -> 增量 draft
  -> QQ 文本 / 媒体发送
  -> SQLite 记录入站与出站任务
```

---

## 和官方项目的关系

这个项目参考了：

- [tencent-connect/openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot)
- [openclaw/openclaw](https://github.com/openclaw/openclaw)

主要借鉴了这些思路：

- QQ gateway WebSocket 入站
- 出站消息路由与媒体发送
- 语音 / 文件处理方式
- Markdown 分块发送思路
- “增量回复 -> 分段回传”的设计方向

但两者仍然不同：

| 项目 | 运行位置 | 宿主 |
| --- | --- | --- |
| `openclaw-qqbot` | OpenClaw 插件 | OpenClaw |
| `qq-codex-bridge` | 本地 Node.js 进程 | Codex Desktop |

所以这个项目不是 OpenClaw 插件移植版，而是 **面向 Codex Desktop 的独立桥接实现**。

---

## 项目结构

```text
apps/bridge-daemon/
  src/
    main.ts
    bootstrap.ts
    config.ts
    thread-command-handler.ts
    debug-codex-workers.ts

packages/adapters/qq/
  src/
    qq-gateway-client.ts
    qq-gateway.ts
    qq-api-client.ts
    qq-sender.ts
    qq-media-downloader.ts
    qq-media-parser.ts
    qq-stt.ts

packages/adapters/codex-desktop/
  src/
    cdp-session.ts
    codex-desktop-driver.ts
    composer-heuristics.ts
    reply-parser.ts

packages/orchestrator/
  src/
    bridge-orchestrator.ts
    media-context.ts
    qq-outbound-draft.ts
    qq-outbound-format.ts
    qqbot-skill-context.ts

packages/store/
  src/
    sqlite.ts
    session-repo.ts
    message-repo.ts
```

---

## 环境要求

- macOS
- Node.js 20+
- `pnpm`
- 已安装 Codex Desktop
- Codex Desktop 可通过远程调试端口暴露 page target
- QQ 官方机器人 `AppID` 和 `ClientSecret`

---

## 快速开始

### 1. 安装依赖

```bash
cd qq-codex-bridge
pnpm install
```

### 2. 准备环境变量

```bash
cp .env.example .env
```

最少需要配置：

- `QQBOT_APP_ID`
- `QQBOT_CLIENT_SECRET`

### 3. 启动 Codex Desktop 远程调试

默认端口：

- `CODEX_REMOTE_DEBUGGING_PORT=9229`

项目的 `pnpm dev` 会尽量自动拉起 Codex Desktop；如果你本地环境特殊，也可以先手动启动。

### 4. 启动桥接

```bash
pnpm dev
```

正常启动日志类似：

```text
[qq-codex-bridge] codex desktop ready { launched: true|false, remoteDebuggingPort: 9229 }
[qq-codex-bridge] ready { transport: 'qq-gateway-websocket', accountKey: 'qqbot:default' }
```

### 5. 在 QQ 中联调

建议先按这个顺序测试：

1. 普通文本
2. 一条会让 Codex 分阶段回答的问题
3. 一条语音
4. 一张图片
5. `/t` 与 `/tu 2`

---

## STT 配置

项目支持三层语音转写策略。

### 1. 零配置模式

不配置任何 `QQBOT_STT_*` 时：

- 优先使用 QQ 事件里的 `asr_refer_text`
- 如果 QQ 没返回 ASR，再回退到附件占位

这是最适合开源项目默认体验的模式。

### 2. 云端 STT

支持：

- `openai-compatible`
- `volcengine-flash`

适合需要更高转写稳定性的人。

### 3. 本地离线 STT

支持：

- `local-whisper-cpp`

适合重视隐私、不想依赖云端 API 的人。

### STT 日志

当前会输出这些 STT 日志：

- `qq stt started`
- `qq stt completed`
- `qq stt produced no transcript`
- `qq stt fallback used`
- `qq stt failed`

日志中会带：

- `provider`
- `file`
- `extension`
- `durationMs`
- `hasAsrReferText`
- `transcriptPreview`

---

## 当前实现上的一些保护逻辑

这几个点是项目和“最小 demo”相比比较重要的部分：

- **重复 QQ 入站抑制**  
  短时间内同一会话、同一正文、同一媒体指纹的重复消息会被拦下，避免同一句话多次注入 Codex。

- **长耗时任务回复采集窗口延长**  
  图片生成、长搜索、长工具执行不再因为默认 30 秒窗口被提前截断。

- **单条 draft 发送失败不再截断整轮回复**  
  某一条 QQ 发送失败时，后续 draft 仍会继续尝试发送。

- **可恢复错误不会把整个桥接打成不可用**  
  比如 `reply_timeout` 这类错误会被当成可恢复错误记录，不再直接把会话打成 `needs_rebind`。

---

## 已知限制

- 核心能力依赖 Codex Desktop 当前版本的 DOM 结构和 CDP 可见性，桌面端改版后可能需要跟着适配。
- 对 Codex 回复的增量采集仍然是 **基于页面快照的伪流式**，不是官方内部事件流。
- QQ 客户端自己的消息样式、Markdown 支持、媒体卡片展示不完全可控。
- 线程管理命令目前只在 **QQ 私聊** 中开放。
- 某些极端场景下，如果 Codex Desktop 页面结构变化很大，线程定位与回复提取可能失效。

---

## 调试建议

### 查看类型检查

```bash
pnpm run check
```

### 运行测试

```bash
pnpm test
```

### 调试 Codex page / worker

```bash
pnpm run debug:codex-workers -- --duration-ms 12000
```

---

## 安全提醒

- `.env` 里会包含 QQ Bot、STT 等敏感密钥，不要提交到仓库
- 如果你把项目分享给别人，请务必轮换已经暴露过的密钥
- 本项目会处理用户消息、附件、语音与本地文件路径，联调时请注意隐私边界

---

## 贡献

欢迎 issue、讨论和 PR。

在提交改动前，建议至少执行：

```bash
pnpm run check
pnpm test
```

更多约定请看：

- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
- [SECURITY.md](./SECURITY.md)

---

## License

本仓库使用 [MIT License](./LICENSE)。
