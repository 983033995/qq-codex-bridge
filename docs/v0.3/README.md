# qq-codex-bridge v0.3 — AI Control Center

本目录是 `codex/v0.3-ai-control-center` 分支的唯一需求与实施基线。

## 版本目标

v0.3 不新增独立远程客户端、远程设备页、手机 App、PWA 或新的聊天界面。产品继续以 **QQ / 微信 / 飞书** 作为日常消息入口，以 **MCP** 作为 AI 驱动的初始化与控制入口，以现有 **Control UI** 作为高级管理与诊断界面。

核心目标：

1. 用户配置 MCP 后，不再需要手动在终端执行 npm/pnpm 命令来启动 Bridge。
2. MCP 首次调用自动确保 Runtime 就绪，并允许 AI 在当前对话内完成渠道初始化。
3. 微信支持对话内输出二维码；QQ、飞书支持对话内收集所需字段并完成校验。
4. Admin 与 MCP 共用同一套 Application Service，不允许出现两套配置与业务逻辑。
5. Codex AppServer 保持主链路；CDP 仅作为单会话、安全的 pre-submit recovery。
6. Approval、Turn Ledger、Runtime 状态和渠道状态持久化，提升长时间运行可靠性。

## 明确不做

- Remote Device
- Cloudflare Relay
- iOS / Android 客户端
- PWA 聊天端
- 独立桌面客户端
- 公网暴露 Control API
- 公网暴露 Codex AppServer
- 新的聊天入口

## 文档索引

- [PRD — 产品需求](./PRD.md)
- [PROTOTYPE — 完整原型与交互链路](./PROTOTYPE.md)
- [ARCHITECTURE — 技术架构与开发规范](./ARCHITECTURE.md)
- [IMPLEMENTATION_PLAN — 可直接执行的任务计划](./IMPLEMENTATION_PLAN.md)

## 开发顺序

严格按以下阶段推进：

1. Runtime Foundation
2. MCP Setup / Config / Secret Store
3. Approval
4. Durable Turn Ledger + Transport Isolation
5. Control Center UI

未经需求变更，不应跳过前置阶段直接大规模改 UI。

## 版本一句话定义

> 将 qq-codex-bridge 从“需要开发者手动启动和配置的消息桥”升级为“配置 MCP 后即可由 AI 自动初始化、自动拉起并持续通过 QQ、微信、飞书使用 Codex 的本地 Agent Gateway”。
