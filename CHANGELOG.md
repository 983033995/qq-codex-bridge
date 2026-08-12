# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的整理方式，并约定使用语义化版本风格来描述发布节奏。

## [Unreleased]

### Added

- **MCP 渠道排版规范**：新增 `get_channel_format_guide`；`push_message` / `list_push_targets` 默认暴露飞书→markdown、微信→plain、QQ 主动推送不可用等写作规范，`list_push_targets` 附带 `recommendedFormat` / `formatSummary`
- 私聊快捷指令 `/push <alias> <message>` 和 `/push targets`，可在任意已接入渠道内直接触发或查看 Agent 主动推送目标（对齐 `docs/PRODUCT-SPEC-v0.2.md` 第 7 节，此前只有 HTTP/MCP 两条路径）
- 飞书对话回复补齐媒体解析（图片），与 Agent 推送链路能力对齐；不支持的媒体类型会收到明确文字提示而不是被静默丢弃
- 飞书 `post` 富文本改为真正解析 Markdown 结构：提取真实超链接为 `a` 标签，标题/列表/加粗/代码标记降级为可读纯文本
- 微信入站收到图片/视频/文件消息时会返回明确的"暂不支持下载"占位提示，而不是像之前一样静默丢弃整条消息
- 管理页创建 QQ 推送目标时会给出明确警告：QQ 官方机器人当前没有验证过的主动推送 API，此类目标的推送会始终失败
- 管理页"推送目标"页展示排队中/已送达/失败的推送任务数量
- `desktopDriver.replyTimeoutMs` / `desktopDriver.staleTurnInterruptMs`（`CODEX_REPLY_TIMEOUT_MS` / `CODEX_STALE_TURN_INTERRUPT_MS`）：把"回复采集超时"和"陈旧 turn 打断阈值"拆分为两个独立可配置项，避免长耗时任务被误判为陈旧而打断

### Fixed

- **飞书富文本排版**：对话回复与主动推送的 `post` 消息改为优先使用官方推荐的 `md` 标签（CommonMark 0.31 + GFM），保留标题/列表/加粗/代码块/表格/链接等真实样式，而不再把 Markdown 降级成纯文本
- **飞书 `/t` `/help` 表格显示成管道符纯文字**：`shouldUseFeishuRichText` 未识别 Markdown 表格，控制指令回复落到了 `msg_type=text`；现已把表格行/分隔行纳入富文本判定，走 `post` + `md` 渲染
- **`/tn` 在 Codex App 侧边栏不可见**：AppServer 新建线程后未调用 `thread/name/set`（标题一直为 null），且未主动转发 `thread/started`；现已设置标题并尝试转发到桌面 UI（需 CDP）。无 CDP 时仍需重启 App 才能从 `~/.codex` 刷新侧边栏
- **`/model use` 不再依赖 CDP UI**：当前 Codex AppServer 已提供 `config/value/write`，模型切换直接写 `~/.codex/config.toml`，与桌面端共用同一配置，无需单独开一个带调试端口的 Codex 窗口
- **微信 Agent 主动推送图片/文件必现 400 失败**：`weixin-gateway` 的 `/messages` 请求校验要求 `mediaArtifacts[].sourceUrl` 非空，但 Agent 推送产生的媒体只有本地文件（`PUSH_OUTBOX_ROOT` 下的路径），从不携带远程地址，导致每一次图片/文件主动推送都会在真正投递前被拒绝，Agent 只能退化成把本地路径当文本发出去。已放宽校验为允许空字符串（真正读取时以 `localPath` 为准，`sourceUrl` 仅在 `localPath` 读取失败时才会兜底使用），并用真实凭证完成了图片、文件的端到端主动推送回归（均已确认送达）
- **Codex App 改版后 `/threads` `/t` 排序与真实客户端不一致**：当前 AppServer 版本新增了 `recency_at` 排序键，反映真实的"最近被使用"时间；旧的 `updated_at` 会被后台静默写入干扰，不再等价于"最近活动"。驱动现在优先探测并使用 `recency_at`（旧版 AppServer 不支持时自动回退 `updated_at`），"最近活动"展示时间也随之切换到 `recency_at`
- `push_message` MCP 工具的 `media` 字段缺少使用说明，导致 Agent 不知道媒体路径必须先落地到推送沙箱目录才能引用；补充了工具描述与更可操作的 `media_sandbox_violation` 报错文案（直接带出沙箱根目录的真实路径）

### Changed

- `switchModel` 在没有 CDP 兜底驱动时的报错信息更明确地说明这是环境限制（AppServer 协议未提供模型切换 RPC），而不是笼统的失败提示

## [0.2.0] - 2026-08-03

### Added

- 统一桌面驱动，优先使用 AppServer，并在消息确认发送前安全降级到 CDP
- QQ、微信、飞书统一入站对话；飞书采用官方 SDK 长连接
- Agent 主动推送 HTTP API、MCP stdio 工具、目标别名与持久化重试队列
- 推送 Token 鉴权、目标授权、限流、媒体沙箱、幂等和重启恢复
- 版本化 CDP 选择器配置、Codex 本地数据库自动发现和统一媒体引用采集

### Changed

- `chatgpt-desktop` 存量会话读取时映射到统一桌面行为
- AppServer 成为默认主传输，CDP 仅作为可控降级路径
- 旧 ChatGPT AX provider、`/source chatgpt` 与 `/cgpt` 停止默认装配并进入弃用期

### Security

- 主动推送默认关闭且默认仅监听 loopback；远程监听必须显式授权
- API 和 MCP 只能使用已登记目标别名，不能直接提交渠道原始 ID
- 推送媒体仅允许来自受控 outbox 的真实文件，拒绝远程 URL、`file://` 和符号链接越界

## [0.1.4] - 2026-04-26

### Added

- QQ 官方 Bot 与 Codex Desktop 的桥接主链路
- QQ 私聊 / 群聊会话隔离
- SQLite 持久化会话、入站消息、出站任务
- QQ 媒体下载与回传
- 多种 STT 模式
  - QQ `asr_refer_text` 回退
  - `openai-compatible`
  - `volcengine-flash`
  - 本地 `whisper.cpp`
- Codex 回复增量采集与多次回传
- 私聊线程命令与简写
  - `/threads` / `/t`
  - `/thread current` / `/tc`
  - `/thread use` / `/tu`
  - `/thread new` / `/tn`
  - `/thread fork` / `/tf`
  - `/help`
- 开源仓库基础文档
  - `README.md`
  - `CONTRIBUTING.md`
  - `CODE_OF_CONDUCT.md`
  - `SECURITY.md`
  - issue / PR 模板
- GitHub Actions CI
- README 项目效果图与状态徽章
- **多 QQ Bot 并行接入**：支持通过 `QQBOTS_JSON` 或 `QQBOT_ACCOUNT_IDS` + 分账号变量同时接入多个 QQ Bot，每个 bot 独立 session store 与媒体目录
- **多微信账号并行接入**：支持通过 `WEIXIN_ACCOUNTS_JSON` 或 `WEIXIN_ACCOUNT_IDS` + 分账号变量同时运行多个微信 long-poll 客户端，每个账号独立 webhookPath 与 egress
- **ChatGPT Desktop 对话源**：新增 `chatgpt-desktop` 作为第二个 AI 后端，通过 macOS Accessibility API 驱动；支持对话列表、切换、新建
- **双源切换命令**：`/source`、`/source codex`、`/source chatgpt` 可在每个私聊会话内独立切换 AI 来源
- **账号状态命令**：`/accounts` 查看当前会话的渠道来源、accountKey、对话源及所有已接入账号
- **ChatGPT 对话管理命令**：`/cgpt`、`/cgpt use <序号>`、`/cgpt new` 用于直接管理 ChatGPT Desktop 侧边栏对话
- **图片附件发送至 ChatGPT Desktop**：支持把 QQ / 微信收到的图片附件通过剪贴板注入到 ChatGPT Desktop 输入框
- **AI 生图回传**：ChatGPT Desktop 图片生成结果通过 Kingfisher 缓存目录（`image-cache`）自动检测并回传到 QQ / 微信
- **微信网关多账号支持**：`WEIXIN_GATEWAY_ACCOUNTS_JSON` / `WEIXIN_GATEWAY_ACCOUNT_IDS` 支持单进程内运行多个微信 long-poll client

### Changed

- 改善了长耗时任务的回复采集窗口，避免图片 / 文件结果在后半段丢失
- 改善了重复 QQ 入站的短窗口去重，避免同一条消息重复注入 Codex
- `/threads` 输出改为更适合手机查看的 Markdown 表格
- `/thread use` 与 `/threads` 使用统一的项目名识别逻辑
- 改善了复杂 Markdown、代码块和表格的桥接处理
- 改善了可恢复错误的处理方式，避免单条失败拖垮整轮会话
- 线程命令（`/t`、`/tu`、`/tn` 等）在切换对话源后自动路由到对应的 Desktop 应用
- `image-cache` 快照改为基于时间戳 diff，区分历史缓存与新生成图片，避免误发旧文件
- `config.ts` 重构为支持多 bot / 多账号的通用配置加载器
- `bootstrap.ts` / `main.ts` 重构以并行初始化多个 QQ 和微信 adapter
- README 全面更新，反映双源架构、多 bot 配置与完整命令列表

### Fixed

- 修复了部分场景下 `CDP runtime evaluation failed` 的脚本注入问题
- 修复了提交消息进入输入框但未真正发送的重试与确认问题
- 修复了媒体回传中后半段结果未落库的问题
- 修复了文档中的本机绝对路径残留
- 修复了 `/cgpt use` 切换后下一条消息仍新建会话的问题
- 修复了 `image-cache` `diffCache` 在文件名相同但内容更新时不检测新图的问题

---

## 发布约定

- 开发中的改动先记录在 `Unreleased`
- 发布版本时，将 `Unreleased` 内容归档到对应版本号，例如 `0.1.0`
- GitHub Release 推荐使用 tag 触发，例如：

```bash
git tag v0.1.0
git push origin v0.1.0
```
