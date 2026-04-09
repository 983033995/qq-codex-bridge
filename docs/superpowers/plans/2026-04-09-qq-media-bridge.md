# QQ 富媒体双向桥接 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `qq-codex-bridge` 增加 QQ 与 Codex 之间的图片、文件、语音、视频双向桥接能力。

**Architecture:** 通过统一的 media artifact 模型串联 QQ 入站附件下载、Codex 上下文注入、Codex 出站媒体解析和 QQ 媒体发送。QQ 入站保留本地路径并尽量提取可读文本；Codex 出站同时支持 `<qqmedia>` 与 Markdown 声明。

**Tech Stack:** TypeScript、QQ Bot OpenAPI、QQ gateway WebSocket、SQLite、Codex Desktop CDP、Node.js 文件系统

---

### Task 1: 定义媒体领域模型与端口

1. 增加统一的 media artifact 领域类型，覆盖图片、文件、语音、视频和提取文本。
2. 扩展入站消息与 transcript 能力，使单条 QQ 消息可携带文本和多个媒体工件。
3. 扩展 QQ 适配层端口，为媒体发送和媒体下载预留清晰接口。

### Task 2: 实现 QQ 入站附件归一化与本地落盘

1. 解析 QQ gateway 事件中的附件元数据，识别图片、文件、语音、视频。
2. 下载附件到运行时媒体目录，并生成 media artifact。
3. 为附件识别与下载流程补合同测试和失败路径测试。

### Task 3: 实现媒体提取与 Codex 上下文拼接

1. 为文本类文件、语音、图片、视频补最小提取策略。
2. 将文字内容、附件清单、本地路径和提取文本合并成发送给 Codex 的上下文。
3. 为提取失败保留保底路径与元信息，不阻塞主链路。

### Task 4: 实现 Codex 出站媒体声明解析

1. 解析 `<qqmedia>...</qqmedia>` 标签。
2. 解析 Markdown 图片和可识别的媒体链接声明。
3. 产出统一的出站媒体草稿，并保持文本与媒体顺序。

### Task 5: 实现 QQ 媒体发送路由

1. 补充 QQ API client 的图片、文件、语音、视频发送能力。
2. 按媒体类型路由到不同 QQ 接口，并处理大小限制。
3. 对文本和媒体混发的场景保持稳定顺序和被动回复字段。

### Task 6: 将富媒体链路接入现有编排器

1. 在 QQ gateway 入站中挂接附件归一化。
2. 在 conversation provider 中将媒体上下文注入 Codex。
3. 在 QQ egress 中接入文本+媒体混合发送。

### Task 7: 补技能、文档与真实联调

1. 新增 `qq-codex-media` 技能，约定 `<qqmedia>` 与 Markdown 双格式。
2. 更新 README 中的富媒体能力说明。
3. 使用真实 `pnpm dev` 做 QQ -> Codex 与 Codex -> QQ 双向联调。
