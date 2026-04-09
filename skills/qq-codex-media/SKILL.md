---
name: qq-codex-media
description: QQ 与 Codex 之间的富媒体双向桥接技能。支持 QQ 入站图片、文件、语音、视频进入 Codex 上下文，也支持 Codex 通过 <qqmedia> 标签或 Markdown 声明回发媒体到 QQ。
metadata: {"codex":{"emoji":"📎","repo":"qq-codex-bridge"}}
---

# QQ Codex 富媒体

## 何时使用

当用户在 QQ 会话中涉及以下需求时使用本技能：

- 发送图片、文件、语音、视频给机器人并希望 Codex 能理解
- 让 Codex 回发图片、文件、语音、视频
- 需要在回复中同时包含文本和媒体

## 入站行为

QQ 入站附件会被桥接下载到本地运行时目录，并作为附件上下文注入 Codex：

- 图片：保留本地路径和基础摘要
- 语音：保留本地路径和基础摘要
- 视频：保留本地路径和基础摘要
- 文件：保留本地路径；文本类文件会尽量提取正文

Codex 看到的不是单纯一条文本，而是：

- 用户原始文字
- 附件列表
- 每个附件的本地路径
- 可读提取文本或摘要

## 出站声明格式

支持两种格式，二选一或混用都可以。

### 1. `qqmedia` 标签

```text
这是你要的图片：
<qqmedia>/tmp/cat.png</qqmedia>
```

```text
<qqmedia>https://example.com/demo.mp4</qqmedia>
```

### 2. Markdown

图片：

```markdown
![封面](/tmp/cover.png)
```

文件或视频：

```markdown
[演示视频](https://example.com/demo.mp4)
[报告文件](/tmp/report.pdf)
```

## 规则

1. 本地路径优先使用绝对路径
2. 远程资源使用 `http://` 或 `https://`
3. 文本和媒体可以混发，桥接会按声明顺序发送
4. 如果用户明确要发媒体，不要只返回路径说明，应直接输出媒体声明
5. 文本类文件尽量让 Codex先阅读提取内容，再决定是否回发原文件

## 示例

```text
这是处理后的报告：
[报告文件](/tmp/report.pdf)
```

```text
这里是语音版本：
<qqmedia>/tmp/tts-answer.mp3</qqmedia>
```

```text
我把封面和视频一起发给你：
![封面](/tmp/cover.png)
[演示视频](/tmp/demo.mp4)
```
