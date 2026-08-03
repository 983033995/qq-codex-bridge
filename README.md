# qq-codex-bridge

![CI](https://github.com/983033995/qq-codex-bridge/actions/workflows/ci.yml/badge.svg)
[![License](https://img.shields.io/github/license/983033995/qq-codex-bridge)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)

![qq-codex-bridge README Hero](./output/readme-hero-nanobanana-productized-v1.png)

## 把统一 Codex / ChatGPT App 接入 QQ、微信和飞书

**qq-codex-bridge** 是一个开源本地桥接工具：用户可以从 **QQ、微信或飞书**发起对话，统一桌面驱动再把消息交给合并后的 **Codex / ChatGPT App**。Codex、Claude 等 Agent 也可以通过 HTTP API 或 MCP 主动推送任务汇报、告警和自动化结果。

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
QQ Bot / 微信 / 飞书
      │
      ▼
BridgeOrchestrator（本地 Node.js 进程）
      │
      ├── SessionStore / TranscriptStore（SQLite）
      ├── Channel Sender（QQ / 微信 / 飞书）
      ├── Push API / Durable Queue ◄── HTTP / MCP Agent
      │
      └── UnifiedDesktopDriver
          ├── AppServer（主传输）
          └── CDP（发送前故障降级）
```

桥接默认运行在本机。`auto` 模式优先使用 AppServer；只有在本轮消息尚未确认发送时才允许降级到 CDP，避免重复提交。AppServer 恢复后从下一轮回切。旧 ChatGPT AX provider 在 v0.2 只保留兼容代码，不再作为默认装配路径。

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
| `DESKTOP_DRIVER_TRANSPORT` | 桌面传输策略：`auto` / `app-server` / `cdp` | `auto` |
| `CODEX_SELECTOR_PROFILE` | CDP 降级路径的内置选择器版本 | `v27` |
| `CODEX_SELECTOR_FILE` | 严格校验的自定义选择器 JSON 文件 | — |
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

## 飞书通道

飞书首版使用官方 Node SDK 长连接接收 `im.message.receive_v1`，不需要公网回调地址。出站支持文本、富文本和图片。

```env
FEISHU_ENABLED=true
FEISHU_ACCOUNT_ID=default
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=your-app-secret
```

飞书应用需要开通消息读取、消息发送和图片上传权限，并在事件订阅中启用 `im.message.receive_v1`。HTTP 回调、卡片交互和批量发送不属于 v0.2。

---

## Agent 主动推送

主动推送默认关闭。启用后先在管理页 `http://127.0.0.1:3100/admin` 的“推送目标”页面，从已有会话创建目标别名；API 和 MCP 只能使用别名，不能直接传群号、OpenID 或 wxid。

```env
PUSH_ENABLED=true
PUSH_TOKEN=replace-with-at-least-32-random-bytes
PUSH_OUTBOX_ROOT=runtime/media/push-outbox
```

HTTP 调用示例：

```bash
curl -X POST http://127.0.0.1:3100/api/v1/push \
  -H "Authorization: Bearer $PUSH_TOKEN" \
  -H "Idempotency-Key: build-report-20260803" \
  -H "Content-Type: application/json" \
  -d '{"target":"daily-report-group","message":{"text":"构建完成","format":"plain","media":[]},"metadata":{"source":"codex","taskId":"task-123"}}'
```

固定返回 `202` 和 `{ pushId, status: "queued", duplicate }`。可通过 `GET /api/v1/push/:pushId` 查询状态。媒体路径必须位于 `runtime/media/push-outbox` 的真实文件中，远程 URL、`file://` 和符号链接越界会被拒绝。

Codex / Claude MCP 配置：

```json
{
  "mcpServers": {
    "qq-codex-push": {
      "command": "qq-codex-mcp",
      "env": {
        "MCP_PUSH_BASE_URL": "http://127.0.0.1:3100",
        "MCP_PUSH_TOKEN": "replace-with-the-same-push-token"
      }
    }
  }
}
```

MCP 通过 stdio 工作，不监听额外网络端口，提供 `push_message`、`push_task_report`、`list_push_targets`、`get_push_status` 四个工具。

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

## 统一桌面传输与兼容命令

v0.2 默认只装配 `UnifiedDesktopDriver`。旧命令仍保留到 v0.3，调用时会给出弃用提示：

```text
/source          查看兼容状态
/source codex    使用统一桌面驱动
/source chatgpt  已弃用；不再切换到 AX 默认路径
```

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
- 飞书官方 SDK 长连接入站，支持文本、富文本和图片出站
- QQ 私聊 / 群聊会话隔离
- 多通道会话隔离（QQ / 微信 / 飞书）
- 统一桌面驱动：AppServer 主传输 + CDP 安全降级
- 每个会话独立绑定统一 App 线程
- SQLite 持久化会话、入站记录、出站任务
- Agent 主动推送 API、MCP stdio 工具和持久化重试队列

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

**统一桌面驱动下可用：**

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

**通用命令：**

| 用途 | 命令 |
| --- | --- |
| 查看兼容来源状态 | `/source`（deprecated） |
| 使用统一桌面驱动 | `/source codex`（deprecated） |
| 旧 AX 来源 | `/source chatgpt`（deprecated，不再默认装配） |
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

- AppServer 与统一 App 的内部协议仍可能随产品版本变化；不可用时会降级到 CDP
- CDP fallback 仍依赖页面 DOM，选择器配置可以独立更新，但大改版仍可能需要适配
- 对 AI 回复的增量采集是**基于页面快照的伪流式**，不是官方内部事件流
- QQ 客户端的消息样式、Markdown 支持、媒体卡片展示不完全可控
- 微信当前只开放了**文本通道**，还没有内置图片、语音、文件与真实提供方签名适配
- 飞书真实租户权限、长连接重连和渠道限额需要用实际应用凭据联调
- QQ 主动消息能力取决于腾讯侧账号权限；不支持时任务会返回 `channel_unsupported`
- 线程管理命令目前只在私聊中开放

---

## 环境要求

- macOS
- Node.js 20+
- 已安装合并后的 Codex / ChatGPT App，或可访问的 Codex AppServer
- QQ 官方机器人 `AppID` 和 `ClientSecret`

---

## 安全提醒

- `.env` 里包含 QQ Bot、STT 等敏感密钥，**不要提交到仓库**（`.gitignore` 已默认排除 `.env`）
- `PUSH_TOKEN` 至少 32 字节，默认只在 loopback 使用；不要把 Token 写入日志或命令参数历史
- 推送目标必须在本机管理页从已有会话登记，Agent 只接触目标别名
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
- [v0.2 产品说明书](./docs/PRODUCT-SPEC-v0.2.md)
- [v0.2 重构与迁移计划](./docs/REFACTOR-PLAN-v0.2.md)
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
