# QQ 私聊线程管理设计

## 目标

在 QQ 私聊中支持直接管理 Codex Desktop 左侧真实线程列表，包括：

- 查看最近 20 条线程
- 查看当前 QQ 私聊绑定的线程
- 切换到指定线程
- 创建新线程并切换
- 从当前 QQ 对话最近几轮摘要 fork 新线程并切换

## 约束

- 仅在私聊中开放线程管理命令
- 线程来源必须是 Codex Desktop 左侧真实会话列表，而不是 page target
- 普通 QQ 消息仍然走当前绑定线程
- 对现有 QQ gateway 入站、SQLite 会话隔离和 Codex Desktop 自动驱动尽量少侵入

## 命令

- `/threads`
- `/thread current`
- `/thread use <index>`
- `/thread new <title>`
- `/thread fork <title>`

## 设计

Codex Desktop 只有一个真实 page target，线程切换发生在同一页面的左侧边栏中，因此 `codex_thread_ref` 需要从“只表示 page target”升级为“page target + 线程定位信息”。线程定位信息优先使用 `projectName + threadTitle`，因为当前 DOM 中线程标题由 `[data-thread-title="true"]` 提供，当前线程由 `aria-current="page"` 标识，顶部“新线程”按钮也可稳定定位。

QQ 私聊命令在进入主对话编排前先被拦截。命令处理器负责做去重、会话锁、线程查询/切换/创建，并直接通过 QQ egress 回发控制结果。只有非命令普通消息才继续进入现有 orchestrator。

`/thread new` 和 `/thread fork` 都会新建真实 Codex 线程，然后注入一条仅用于建立线程主题的首条消息。`/thread new` 使用标题作为首条种子上下文，`/thread fork` 使用“最近几轮 QQ 对话摘要”作为首条上下文。对应的 Codex 回复不会回发到 QQ，只用于让真实线程在左侧列表中成型并完成绑定。

## 验证

- 合同测试覆盖线程列表解析、线程切换和新线程创建
- 单元测试覆盖 QQ 私聊命令解析和绑定更新
- 全量 `npm test` 与 `npm run check`
- 真实 `pnpm dev` 联调，确认 `/threads`、`/thread use`、`/thread new`、`/thread fork` 可在 QQ 私聊中使用
