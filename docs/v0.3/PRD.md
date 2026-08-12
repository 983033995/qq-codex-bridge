# v0.3 PRD — AI Control Center

## 1. 背景

当前 `codex/v0.2-unified-refactor` 已完成多渠道、AppServer、CDP Recovery、Control UI、Router、Push/MCP 等能力的统一重构，但仍存在几个明显的产品化问题：

- Bridge 需要用户主动在终端启动。
- MCP 依赖既有 Runtime，不能自行确保服务可用。
- 普通用户仍需要理解 `.env`、npm/pnpm、AppServer、PID 等实现细节。
- 渠道初始化缺少统一的 AI 驱动 Setup Protocol。
- Codex Approval 尚未成为统一的产品能力。
- 部分 Turn 状态仍依赖进程内存，重启恢复能力不足。
- Control UI 仍偏工程管理后台，尚未完全以“任务 / 审批 / 渠道”组织信息。

## 2. 产品定位

v0.3 的产品形态为：

- **QQ / 微信 / 飞书**：日常消息入口。
- **MCP**：AI 驱动的初始化、控制与诊断入口。
- **Control UI**：高级配置、可视化任务、审批、日志与诊断入口。
- **Bridge Runtime**：独立常驻的本地服务。
- **Codex AppServer**：主 Agent 控制通道。
- **CDP**：仅作为安全的单会话 pre-submit recovery。

不新增独立 Remote 产品。

## 3. 用户目标

### 新用户

希望做到：

1. 添加 MCP。
2. 直接对 AI 说“帮我连接微信/QQ/飞书”。
3. AI 自动拉起 Runtime。
4. AI 在当前对话中展示二维码或收集配置字段。
5. 渠道连接成功后直接使用。
6. 无需进入终端。

### 老用户

希望做到：

1. 现有 `.env` / SQLite / Channel 配置可平滑迁移。
2. 升级后无需重新登录全部渠道。
3. 原有 Push/MCP、QQ/微信/飞书消息能力保持兼容。

## 4. P0 需求

### 4.1 Runtime 自动拉起

新增 RuntimeManager，提供：

- `ensureRunning()`
- `start()`
- `stop()`
- `restart()`
- `getStatus()`
- `doctor()`

Runtime 必须：

- 单实例运行。
- 支持 PID + lock + health check。
- 能清理 stale PID / stale lock。
- 多个 MCP Host 同时启动时只产生一个 Bridge Runtime。
- MCP 退出后 Runtime 不自动退出。

### 4.2 MCP AI Control Plane

MCP 工具分五组。

#### Setup

- `get_setup_status`
- `start_setup`
- `submit_setup`
- `get_setup_progress`
- `cancel_setup`

#### Channels

- `list_channels`
- `test_channel`
- `restart_channel`
- `remove_channel`

#### Tasks

- `list_tasks`
- `get_task`
- `interrupt_task`
- `resolve_approval`

#### Push

保留现有 Push 能力。

#### System

- `get_runtime_status`
- `doctor`
- `restart_runtime`
- `get_admin_url`

MCP 不得 1:1 暴露所有 Control API。

### 4.3 Capability Readiness

不得使用单一 `initialized: true/false` 代表整个系统。

状态模型应至少区分：

- Runtime
- Codex
- QQ
- 微信
- 飞书

只要 Runtime + Codex + 任意一个 Channel ready，系统即可视为可用。

### 4.4 Setup Protocol

所有渠道统一通过 Setup Session 实现。

Setup Session 至少包含：

- `setupId`
- `target`
- `type`
- `state`
- `requiredFields`
- `completedFields`
- `artifacts`
- `createdAt`
- `updatedAt`
- `expiresAt`
- `error`

Setup Artifact 支持：

- QR Code
- Form
- URL
- Instruction
- Status

### 4.5 微信初始化

流程：

1. AI 调用 `start_setup(type=weixin)`。
2. Runtime 启动微信登录流程。
3. MCP 返回二维码 Artifact。
4. AI 在对话里展示二维码。
5. Setup 状态从 `waiting_scan -> scanned -> confirming -> connected`。
6. 二维码过期可重新生成。

### 4.6 QQ 初始化

流程：

1. AI 调用 `start_setup(type=qq)`。
2. 返回 AppID / ClientSecret 字段定义。
3. AI 按需收集字段。
4. `submit_setup` 保存并校验。
5. Secret 写入 Secret Store。
6. 启动并测试 QQ Channel。
7. 返回 connected / validation_failed 等结果。

### 4.7 飞书初始化

与 QQ 一致，核心字段：

- App ID
- App Secret

配置成功后自动启动长连接并执行健康检查。

### 4.8 Secret Store

普通用户配置不得再依赖 `.env` 作为主路径。

要求：

- Secret 独立保存。
- 配置中只保存 `secretRef`。
- MCP/Admin 只能看到 configured 状态，不能读取 Secret 原文。
- 支持替换和删除，不支持明文读取。
- ENV 保留为高级 override。

### 4.9 Approval Center

支持至少：

- command execution approval
- file change approval

Approval 领域对象包含：

- approvalId
- threadId
- turnId
- type
- summary
- command/files/reason
- status
- createdAt

状态：

- pending
- approved
- declined
- resolved
- expired

QQ/微信/飞书至少支持纯文本审批命令。

### 4.10 Transport Isolation

全局首选 Transport 始终为 AppServer。

单个 Session 出现 safe pre-submit failure 后可以降级到 CDP，但：

- 仅影响当前 Session。
- 不得修改全局 preferred transport。
- 下一轮应优先重试 AppServer。
- 记录 fallbackReason / fallbackAt。

### 4.11 Durable Turn Ledger

Turn 状态需持久化，至少记录：

- turnId
- threadId
- sessionKey / spaceId
- status
- transport
- idempotencyKey
- lastSequence
- deliveredTextOffset
- queuedAt / startedAt / completedAt
- failureCode / failureMessage

目标：

- Bridge 重启后不产生明显重复回复。
- Final Reply 不丢失。
- 媒体不重复。
- Channel retry 可基于 checkpoint 恢复。

## 5. Control UI 需求

### 首页

优先展示：

- Runtime 状态
- 正在运行任务数
- 等待审批数
- 在线渠道数
- 需要处理事项
- 进行中任务
- 渠道摘要

### 渠道

展示 QQ / 微信 / 飞书账号、状态、最后活动、测试、重启、重新登录、编辑配置。

### 任务

以 Task 为主对象，支持：

- 全部
- 进行中
- 等待确认
- 已完成
- 失败

技术字段 Thread ID / Turn ID / Transport 默认进入详情，而非列表主列。

### Task Detail

展示时间线：

- 收到用户消息
- Codex 开始
- 读取/修改文件
- Approval 请求
- 用户决策
- 命令执行
- 完成/失败

### MCP

展示：

- MCP 是否可用
- Runtime 自动拉起是否开启
- 最近连接 Host
- 推荐配置片段

### System

Runtime / Diagnostics 页面显示技术细节，包括 PID、AppServer、CDP、SQLite、版本、日志与诊断建议。

## 6. 非功能要求

### 安全

- Control API 保持 loopback-only。
- AppServer 保持 loopback-only。
- Secret 不可读回。
- MCP 不得提供任意 shell / 任意 config mutation 工具。
- Approval 操作必须可审计。

### 可靠性

- RuntimeManager 并发安全。
- Setup Session 可持久化恢复。
- Turn Ledger 可恢复。
- Channel 重启不影响其他 Channel。

### 兼容性

- 不破坏现有 QQ / 微信 / 飞书主链路。
- 不破坏 Push/MCP 现有能力。
- ENV 仍可用于开发和自动化部署。

## 7. Definition of Done

- 配置 MCP 后无需手动启动 Bridge。
- 新用户无需编辑 `.env`。
- 微信可直接在 AI 对话中扫码完成初始化。
- QQ / 飞书可在 AI 对话中完成凭据配置。
- Admin 与 MCP 共用 Setup Service。
- Secret 不可读回。
- Approval 可从渠道和 Admin 处理。
- CDP fallback 仅影响当前 Session。
- Turn 状态持久化。
- 老用户配置可迁移。
- 不新增任何独立 Remote 页面或客户端。
