# OmniAgent Gateway v0.3 — AI Control Center

本目录是 `codex/v0.3-ai-control-center` 分支的唯一需求与实施基线。

> 旧项目名 `qq-codex-bridge` 从 v0.3 起仅作为仓库、npm 包和 CLI 的兼容标识保留；产品显示名统一为 **OmniAgent Gateway**。正式发布前按 [BRANDING.md](./BRANDING.md) 完成兼容迁移。

## 版本目标

v0.3 不新增独立远程客户端、远程设备页、手机 App、PWA 或新的聊天界面。产品继续以 **QQ / 微信 / 飞书** 作为日常消息入口，以 **MCP** 作为 AI 驱动的初始化与控制入口，以现有 **Control UI** 作为高级管理与诊断界面。

核心目标：

1. 用户配置 MCP 后，不再需要手动在终端执行 npm/pnpm 命令来启动 Runtime。
2. MCP 首次调用自动确保 Runtime 就绪，并允许 AI 在当前对话内完成渠道初始化。
3. 微信支持对话内输出二维码；QQ、飞书支持对话内收集所需字段并完成校验。
4. **所有 QQ / 微信 / 飞书入站消息必须先经过 Inbound Intelligent Router，再决定进入 Codex Conversation、Control、Setup 或 Approval。**
5. **所有 Agent / Thread / Task 出站消息必须携带统一 Source Identity，并通过 Conversation Alias + Active Conversation + Reply Routing 解决多 Thread、多 Agent Push 共用同一渠道时的来源识别与回复目标问题。**
6. Admin 与 MCP 共用同一套 Application Service，不允许出现两套配置与业务逻辑。
7. Codex AppServer 保持主链路；CDP 仅作为单会话、安全的 pre-submit recovery。
8. Approval、Turn Ledger、Runtime 状态、渠道状态、Router Decision、Conversation Alias、Channel Message Registry 和 Active Conversation 必须持久化，提升长时间运行可靠性。

## 核心入站链路

```text
QQ / 微信 / 飞书
        │
        ▼
Channel Adapter
        │
        ▼
Inbound Gateway
        │
        ▼
Conversation Context Resolver
        │
        ▼
Inbound Intelligent Router
  ┌─────┼────────┬──────────┬──────────┐
  ▼     ▼        ▼          ▼          ▼
Conversation  Control     Setup     Approval   Clarify
  │          │          │          │
  ▼          ▼          ▼          ▼
Codex     Runtime/    Channel    Approval
          Channel     Setup      Service
          Control
```

Router 是 v0.3 核心架构，不是可选附加能力。普通对话默认进入 Codex；控制、配置和审批意图不得再作为普通 Prompt 发送给 Codex。

多来源消息必须遵循以下回复目标优先级：

```text
reply-to 映射
  ↓
显式 Alias / 切换指令
  ↓
Active Conversation
  ↓
无法确定则 Clarify
```

Agent 主动 Push 默认不得修改当前 Active Conversation。

## 明确不做

- Remote Device
- Cloudflare Relay
- iOS / Android 客户端
- PWA 聊天端
- 独立桌面客户端
- 公网暴露 Control API
- 公网暴露 Codex AppServer
- 新的聊天入口
- v0.3 内实现 Claude/OpenCode 作为渠道消息执行 Agent（它们本版仍通过 MCP 管理和 Push）

## 文档索引

- [PRD — 产品需求](./PRD.md)
- [SOURCE_AND_REPLY_ROUTING — 多来源身份、会话别名、引用回复与 Active Conversation P0 规范](./SOURCE_AND_REPLY_ROUTING.md)
- [PROTOTYPE — 完整原型与交互链路](./PROTOTYPE.md)
- [ARCHITECTURE — 技术架构与开发规范](./ARCHITECTURE.md)
- [IMPLEMENTATION_PLAN — 可直接执行的任务计划](./IMPLEMENTATION_PLAN.md)
- [BRANDING — 命名与兼容迁移规范](./BRANDING.md)

其中 `SOURCE_AND_REPLY_ROUTING.md` 是 PRD 的强制组成部分，不是补充阅读材料。凡涉及 Channel Sender、MCP Push、Codex Thread、Task、Router、Transcript 或消息回复的实现，必须同时满足该规范。

## 开发顺序

严格按以下阶段推进：

1. Baseline + Runtime Foundation
2. MCP Setup / Config / Secret Store
3. **Inbound Intelligent Router**
4. **Conversation Source & Reply Routing**
5. Approval
6. Durable Turn Ledger + Transport Isolation
7. Control Center UI
8. Release Hardening

未经需求变更，不应跳过前置阶段直接大规模改 UI。

## 版本一句话定义

> 将旧的 qq-codex-bridge 升级为 **OmniAgent Gateway**：一个配置 MCP 后即可由 AI 自动初始化和运行，并通过 QQ、微信、飞书接收消息，经智能路由后驱动 Codex 或执行系统控制，同时能够清晰区分多 Agent / 多 Thread 消息来源并可靠解析用户回复目标的本地 Agent Gateway。
