# MCP 渠道消息排版规范能力 — 设计

日期：2026-08-05
状态：Approved（方案 1）

## 背景

Agent 通过 MCP `push_message` 推送到飞书 / 微信 / QQ 时，只有 `format: plain | markdown`，默认 `plain`，工具描述几乎不说明各渠道渲染能力。结果是：飞书表格/标题常被当成纯文本推送，微信侧却可能误开 markdown。

## 目标

在 MCP 层**默认可发现**各地 bot 的排版规范：

1. 现有工具 description 内嵌摘要与推荐 `format`
2. 新增只读工具返回完整规范
3. `list_push_targets` 返回附带每目标的推荐格式摘要

## 非目标

- 不做服务端自动改写正文 / 静默切换 `format`
- 本次不新增 HTTP 公开 API（模块可复用，但不暴露路由）
- 不改变 QQ 主动推送仍 `channel_unsupported` 的行为

## 方案

共享静态模块 `apps/mcp-server/src/channel-format-guide.ts`：

| 渠道 | recommendedFormat | 要点 |
|---|---|---|
| feishu | `markdown` | post + `md`（CommonMark/GFM）：标题、列表、加粗、代码块、表格、链接；媒体走 `media[]` |
| weixin | `plain` | 正文按纯文本；Markdown 语法通常原样显示；链接可预览；媒体走 `media[]` |
| qq | `plain` | 主动推送当前不可用；对话回复侧 Markdown 取决于账号 `markdownSupport`；规范中标明限制 |

### MCP 工具

| 工具 | 变化 |
|---|---|
| `get_channel_format_guide` | **新增**。可选 `channel` 或 `target`（target 时通过 `listTargets` 解析 channel）；无参返回全部渠道 |
| `push_message` | description / `format` 字段说明写入摘要；提示推送前可查 guide；默认仍 `plain` |
| `push_task_report` | description 提示报告类优先 plain，飞书目标可用 markdown（本工具当前仍发 plain，仅文档提示） |
| `list_push_targets` | 每个 target 附带 `recommendedFormat` + `formatSummary` |

### 数据结构（guide 条目）

```ts
type ChannelFormatGuide = {
  channel: "feishu" | "weixin" | "qq";
  recommendedFormat: "plain" | "markdown";
  supportedFormats: Array<"plain" | "markdown">;
  summary: string;          // 一行摘要，给 list_push_targets
  capabilities: string[];   // 支持的能力点
  limitations: string[];    // 限制 / 陷阱
  writingTips: string[];    // Agent 写作建议
  mediaNotes: string;       // 媒体字段用法
};
```

## 成功标准

- Agent 仅看 `push_message` description 就能知道飞书用 markdown、微信用 plain
- 调用 `get_channel_format_guide` 可拿到完整规范
- `list_push_targets` 每个目标带推荐格式，无需额外猜测
- 现有推送行为（默认 format、egress）不变，仅增强可发现性

## 测试

- 单元：guide 模块覆盖三渠道字段完整性
- MCP：工具列表含 `get_channel_format_guide`；调用返回预期 channel；`list_push_targets` 响应含 `recommendedFormat`
