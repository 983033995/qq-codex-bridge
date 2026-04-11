# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的整理方式，并约定使用语义化版本风格来描述发布节奏。

## [Unreleased]

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

### Changed

- 改善了长耗时任务的回复采集窗口，避免图片 / 文件结果在后半段丢失
- 改善了重复 QQ 入站的短窗口去重，避免同一条消息重复注入 Codex
- `/threads` 输出改为更适合手机查看的 Markdown 表格
- `/thread use` 与 `/threads` 使用统一的项目名识别逻辑
- 改善了复杂 Markdown、代码块和表格的桥接处理
- 改善了可恢复错误的处理方式，避免单条失败拖垮整轮会话

### Fixed

- 修复了部分场景下 `CDP runtime evaluation failed` 的脚本注入问题
- 修复了提交消息进入输入框但未真正发送的重试与确认问题
- 修复了媒体回传中后半段结果未落库的问题
- 修复了文档中的本机绝对路径残留

---

## 发布约定

- 开发中的改动先记录在 `Unreleased`
- 发布版本时，将 `Unreleased` 内容归档到对应版本号，例如 `0.1.0`
- GitHub Release 推荐使用 tag 触发，例如：

```bash
git tag v0.1.0
git push origin v0.1.0
```

