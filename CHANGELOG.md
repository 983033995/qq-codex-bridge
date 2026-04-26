# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的整理方式，并约定使用语义化版本风格来描述发布节奏。

## [Unreleased]

暂无。

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
