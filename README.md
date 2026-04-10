# qq-codex-bridge

一个把 QQ 官方机器人会话桥接到 Codex Desktop 的开源实验项目。

它的目标不是复刻 OpenClaw，而是把这几件事接起来：

- 用 QQ 官方 Bot 网关接收私聊和群聊消息
- 按 QQ 会话隔离映射到 Codex Desktop 线程
- 通过 CDP 驱动 Codex Desktop 发送消息、读取回复
- 把 Codex 的文本、媒体引用、语音转写能力回送到 QQ

当前仓库已经能用于真实联调，但仍然属于“实验性可用”阶段，不建议直接当成生产系统。

## 当前能力

### 已完成

- QQ 官方 Bot WebSocket gateway 入站
- QQ 私聊 / 群聊会话隔离
- SQLite 持久化会话、入站记录、出站任务
- Codex Desktop 启动检查与 CDP 连接
- 私聊线程管理命令
  - `/threads`
  - `/thread current`
  - `/thread use N`
  - `/thread new 标题`
  - `/thread fork 标题`
- QQ 附件下载与上下文注入
  - 图片
  - 语音
  - 视频
  - 文件
- 语音转文字
  - QQ 自带 `asr_refer_text` 回退
  - OpenAI 兼容 STT
  - 火山 `volcengine-flash`
  - 本地离线 `whisper.cpp`
- Codex 回复采集
  - 富文本链接提取
  - 有序列表编号保留
  - 流式回复稳定性判断
  - 增量回复多次回传到 QQ
- QQ 出站
  - 纯文本
  - Markdown 按需启用
  - 图片 / 音频 / 视频 / 文件发送
  - 文本分片发送

### 已知限制

- 核心依赖 Codex Desktop 当前版本的 DOM 结构和 CDP 可见性，后续桌面端改版可能需要跟着调整。
- 富媒体消息在 QQ 客户端里的展示样式由 QQ 决定，不一定总是普通聊天气泡。
- 当前没有做成 OpenClaw 那样的宿主 UI，所有会话仍然是“QQ <-> Codex Desktop”桥接。
- 对 Codex 回复的增量采集仍然是“基于页面快照的伪流式”，不是官方内部事件流。
- 线程管理命令目前只在 QQ 私聊里开放，群聊不支持切线程。

## 和官方 `openclaw-qqbot` 的关系

这个项目参考了官方项目：

- [openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot)

主要借鉴了这些设计：

- QQ gateway WebSocket 入站
- QQ 消息类型与媒体发送路由
- 语音 / 文件处理思路
- 出站文本分块
- “流式回复 -> 插件层合并 -> 多次回传”的设计方向

但它和官方项目不是一回事：

- `openclaw-qqbot` 运行在 OpenClaw 宿主中
- `qq-codex-bridge` 运行在 Codex Desktop + 本地 Node.js 进程中

## 项目结构

```text
apps/bridge-daemon/
  src/
    main.ts                  # 主入口
    bootstrap.ts             # 运行时装配
    thread-command-handler.ts# QQ 私聊线程命令
    config.ts                # 环境变量配置解析
    debug-codex-workers.ts   # CDP 调试脚本

packages/adapters/qq/
  src/
    qq-gateway-client.ts     # QQ gateway WebSocket 客户端
    qq-gateway.ts            # 事件分发与归一化
    qq-api-client.ts         # QQ OpenAPI 调用
    qq-sender.ts             # QQ 出站发送
    qq-media-downloader.ts   # 入站附件下载
    qq-stt.ts                # STT 适配层

packages/adapters/codex-desktop/
  src/
    cdp-session.ts           # CDP 连接与页面操作
    codex-desktop-driver.ts  # Codex Desktop 驱动

packages/orchestrator/
  src/
    bridge-orchestrator.ts   # 编排层
    media-context.ts         # 入站消息构造
    qq-outbound-draft.ts     # 出站 draft 富化
    qq-outbound-format.ts    # 出站文本格式整理

packages/store/
  src/
    sqlite.ts
    session-repo.ts
    message-repo.ts
```

## 环境要求

- macOS
- Node.js 20+
- `pnpm`
- 已安装 Codex Desktop
- 能以远程调试端口启动 Codex Desktop
- 有 QQ 官方机器人 `AppID` 和 `ClientSecret`

## 快速开始

### 1. 安装依赖

```bash
cd /Volumes/13759427003/AI/qq-codex-bridge
pnpm install
```

### 2. 准备环境变量

```bash
cp /Volumes/13759427003/AI/qq-codex-bridge/.env.example /Volumes/13759427003/AI/qq-codex-bridge/.env
```

至少要配置：

- `QQBOT_APP_ID`
- `QQBOT_CLIENT_SECRET`

如果你只想先跑文本消息，这两项就够了。

### 3. 启动 Codex Desktop 远程调试

默认使用：

- `CODEX_REMOTE_DEBUGGING_PORT=9229`

项目的 `pnpm dev` 会尽量自动拉起 Codex Desktop；如果你本地环境特殊，也可以手动启动。

### 4. 启动桥接

```bash
pnpm dev
```

看到类似日志说明主链路已启动：

```text
[qq-codex-bridge] codex desktop ready { launched: true|false, remoteDebuggingPort: 9229 }
[qq-codex-bridge] ready { transport: 'qq-gateway-websocket', accountKey: 'qqbot:default' }
```

### 5. 在 QQ 中联调

直接给机器人发私聊消息，或在群里 `@` 它。

推荐先测试：

- 普通文本
- 会让 Codex 分阶段回答的问题
- 一条语音
- 一张图片

## 线程管理命令

仅私聊可用。

- `/threads`：查看最近线程
- `/thread current`：查看当前绑定线程
- `/thread use 3`：切到第 3 个线程
- `/thread new 新主题`：新建线程并切过去
- `/thread fork 新主题`：基于最近几轮上下文 fork 新线程

## STT 配置

项目支持 3 层语音转写策略。

### 1. 零配置模式

不配置任何 `QQBOT_STT_*` 时：

- 语音优先使用 QQ 事件里的 `asr_refer_text`
- 如果 QQ 也没给 ASR，再回退到附件占位

这是最适合开源项目默认体验的模式。

### 2. 云端 STT

支持：

- `openai-compatible`
- `volcengine-flash`

适合想要更高转写稳定性的人。

### 3. 本地离线 STT

支持：

- `local-whisper-cpp`

适合重视隐私或不想依赖云端 API 的人。

### STT 日志

当前会输出这些 STT 相关日志：

- `qq stt started`
- `qq stt completed`
- `qq stt produced no transcript`
- `qq stt fallback used`
- `qq stt failed`

日志里会带：

- `provider`
- `file`
- `extension`
- `durationMs`
- `hasAsrReferText`
- `transcriptPreview`

## 本地 `whisper.cpp`

如果你要启用本地离线 STT，需要准备：

- `whisper-cli`
- 一个 `ggml` 模型文件

项目代码已经支持 `local-whisper-cpp`，但它是可选增强项，不是默认依赖。

## 配置说明

所有主要变量都在：

- [.env.example](/Volumes/13759427003/AI/qq-codex-bridge/.env.example)

最常用的包括：

- `QQBOT_APP_ID`
- `QQBOT_CLIENT_SECRET`
- `QQBOT_MARKDOWN_SUPPORT`
- `QQ_CODEX_DATABASE_PATH`
- `CODEX_REMOTE_DEBUGGING_PORT`
- `QQBOT_STT_PROVIDER`

## 社区协作

如果你准备参与贡献，建议先看：

- [CONTRIBUTING.md](/Volumes/13759427003/AI/qq-codex-bridge/CONTRIBUTING.md)
- [CODE_OF_CONDUCT.md](/Volumes/13759427003/AI/qq-codex-bridge/CODE_OF_CONDUCT.md)
- [SECURITY.md](/Volumes/13759427003/AI/qq-codex-bridge/SECURITY.md)

仓库也已经提供：

- Bug issue 模板
- Feature request 模板
- Pull request 模板

## License

本项目使用 [MIT License](/Volumes/13759427003/AI/qq-codex-bridge/LICENSE)。

## 调试

### 类型检查

```bash
pnpm run check
```

### 全量测试

```bash
pnpm test
```

### 调试 Codex CDP targets

```bash
pnpm run debug:codex-workers -- --duration-ms 12000
```

## 开发现状

当前仓库已经覆盖了：

- 单元测试
- 合同测试
- e2e 测试

最近一次稳定验证结果：

- `pnpm test` 通过
- `pnpm run check` 通过

## 技能文档

仓库里保留了面向 Codex 的技能文档：

- [qq-codex-runtime/SKILL.md](/Volumes/13759427003/AI/qq-codex-bridge/skills/qq-codex-runtime/SKILL.md)
- [qq-codex-thread-management/SKILL.md](/Volumes/13759427003/AI/qq-codex-bridge/skills/qq-codex-thread-management/SKILL.md)
- [qq-codex-media/SKILL.md](/Volumes/13759427003/AI/qq-codex-bridge/skills/qq-codex-media/SKILL.md)

它们主要是项目内部协作资料，不是最终用户使用本仓库的前置条件。

## Roadmap

- 让 Codex Desktop 附件注入更接近真实“贴附件”而不是上下文转述
- 继续收敛 QQ 富媒体在客户端侧的展示效果
- 把增量回复回传策略做得更像官方的 `deliver-debounce`
- 梳理一版更明确的对外 API / 插件化边界

## License

当前仓库还没有单独补许可证文件。如果你准备正式开源，建议下一步补上 `LICENSE`、`CONTRIBUTING.md` 和 issue / PR 模板。
