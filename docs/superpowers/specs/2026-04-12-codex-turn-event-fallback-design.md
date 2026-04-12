# Codex 主动回调桥接兜底发送设计

## 目标

在 `qq-codex-bridge` 中为所有 QQ 会话增加一层“Codex 主动回调桥接”的兜底发送机制，解决长时间复杂任务里后续回复片段丢失的问题。

- 保持现有 QQ 入站、Codex 驱动轮询、`onDraft` 增量发送主链路不变
- 新增一条本机回调侧路，让 `codex-desktop-driver` 在检测到新回复片段和回合结束时主动通知 bridge daemon
- 由桥接统一判断某条消息是否已发送、是否需要补发、以及一轮回复何时结束
- 即使 UI 轮询漏掉后半段，也能依靠 Codex 驱动层的主动事件补齐最终消息

## 约束

- 仅增强现有链路，不重写 QQ 出站发送架构
- 新增回调接口只监听 `127.0.0.1`，不能暴露到外网
- 兜底逻辑必须默认对所有会话生效，不能依赖人工切换模式
- QQ 实际发送内容继续复用当前桥接层可发送的正常文本/媒体格式，不引入新的用户可见协议文本
- 驱动层负责“观察并上报”，桥接层负责“去重、补发、收尾”，职责不能混淆
- 任何主动回调缺失时，系统仍要退化回现有链路，不能因为兜底层故障导致完全无法回复

## 设计

设计上新增一条 `Codex -> bridge daemon` 的本地事件通道。`codex-desktop-driver` 继续在 `collectAssistantReply()` 中轮询 Codex Desktop UI，但在每次稳定拿到新增回复内容时，不只触发现有 `onDraft`，还会通过本地 HTTP 接口向 bridge daemon 主动发送 `turn event`。bridge daemon 接收事件后，不直接绕过 orchestrator，而是在桥接内部维护每一轮回复的 `turn state`，根据 `sessionKey + turnId + sequence` 做幂等控制、差量发送和最终补齐。

新增接口建议为 `POST /internal/codex-turn-events`，只监听 `127.0.0.1`。每个事件统一使用一个消息模型，至少包含 `sessionKey`、`turnId`、`sequence`、`eventType`、`createdAt`、`payload` 和 `isFinal`。事件类型先收敛为三类：`turn.delta` 表示新增可发送内容，`turn.status` 表示中间状态变化，`turn.completed` 表示本轮回复结束。`turn.delta` 和 `turn.completed` 的 `payload` 中都允许携带 `text`、`fullText`、`mediaReferences` 和 `replyToMessageId`，这样桥接既能按增量发，也能在结束时按完整态补齐。

桥接内部为每个 `sessionKey + turnId` 建立一份 `turn state`，核心字段包括：`lastSequence`、`assembledText`、`sentTextLength`、`observedMediaReferences`、`lastEventAt`、`completed` 和 `finalFlushed`。收到 `turn.delta` 时，如果 `sequence` 已处理过则丢弃；否则优先用 `payload.fullText` 更新 `assembledText`，没有 `fullText` 时再回退到拼接增量 `text`。随后桥接计算 `assembledText.slice(sentTextLength)` 得到尚未发送的差量，仅对这部分走现有 QQ 发送逻辑。这样即便重复收到同一批 delta，或者 UI 轮询重叠，QQ 侧也只会看到一次发送。

`turn.completed` 是最终兜底的关键。驱动层在两种情况下发送它：一是现有 `collectAssistantReply()` 中已经判定“非 streaming 且稳定轮询满足结束条件”；二是到达 reply timeout 但依然拿到了 `latestNewReply`，此时以 `completionReason=timeout_flush` 的语义触发收尾。桥接收到 `turn.completed` 后，会用它携带的 `fullText` 覆盖更新 `assembledText`，再比对 `sentTextLength`。如果最终完整文本比已经发送到 QQ 的内容更长，桥接只补发差量尾段；如果已经一致，则只标记 `completed=true`、`finalFlushed=true` 并结束本轮，不重复发送。

现有 `onDraft` 主链路保留不动，新的 turn event 机制作为并行双保险。也就是说，正常情况下 `onDraft` 仍然负责快速增量出站，用户能尽早在 QQ 中看到中间结果；而 turn event 则负责确保桥接拿到“这一轮真正完整的状态”。如果 `onDraft` 某次漏发了后半段，但之后 turn event 继续上报 `fullText` 或最终 `turn.completed` 到达，桥接仍可在收尾时补齐。这种设计把可靠性从“单次 UI 抓取是否刚好完整”提升为“增量主链路 + 完整态侧路”的双保险。

结束判定采用双条件。主判定是收到驱动层主动发来的 `turn.completed`；次判定是 turn state 在配置的静默窗口内没有再收到任何事件，则触发保守式超时收尾。超时收尾时，如果已经累计到了 `assembledText`，桥接会先做一次差量 flush，再将该 turn 标记为异常结束，以便后续观测。这样即使极端情况下主动 completed 事件丢失，系统仍能尽量把当前已知的回复发完。

## 模块改动

- `packages/ports/src/conversation.ts`
  - 为 `ConversationRunOptions` 增加 `onTurnEvent?: (event) => Promise<void>` 回调
  - 如有必要，补充共享的 `TurnEvent` 类型出口
- `packages/adapters/codex-desktop/src/codex-desktop-driver.ts`
  - 在 `collectAssistantReply()` 的增量轮询逻辑中生成 `turn.delta` / `turn.status` / `turn.completed`
  - 维持现有 `onDraft` 行为，同时补充主动事件上报
  - 为每一轮回复生成稳定 `turnId`
- `apps/bridge-daemon/src/http-server.ts`
  - 复用现有 webhook server 风格，新增内部回调路由或平行 server 工厂
- `apps/bridge-daemon/src/main.ts`
  - 注入内部 turn event ingress
  - 只绑定在 `127.0.0.1`
- `packages/orchestrator/src/bridge-orchestrator.ts`
  - 接入 turn state 管理、差量补发、completed 收尾
  - 保持现有 `handleInbound -> onDraft -> qqEgress.deliver` 主路径兼容
- `packages/adapters/qq/src/qq-sender.ts`
  - 继续只负责发送，不承担会话收尾逻辑

## 验证

- 单元测试覆盖 turn state 的去重、差量计算、final flush 和静默超时
- 合同测试覆盖 `codex-desktop-driver` 在 streaming、稳定结束、timeout flush 三种场景下产出的事件序列
- e2e 测试模拟一轮长回复中 `onDraft` 漏掉后续片段，验证 bridge 仍能通过 `turn.completed` 补齐尾段
- 全量 `pnpm run check`、`pnpm test`
- 本地联调验证：
  - 普通短回复不重复发送
  - 长回复中间多次增量都能到 QQ
  - 人为制造 UI 轮询漏抓后，最终仍能补齐尾段
  - 回调接口不可从非本机地址访问

## 灰度与回滚

- 第一阶段先上线 turn event 记录能力，只接收和落日志，不参与发 QQ
- 第二阶段开启“completed 时补差量”，继续保留 `onDraft` 主链路
- 第三阶段视稳定性决定是否让 `turn.status` 也对 QQ 可见
- 如新链路出现异常，关闭 turn event 消费即可回退到当前仅依赖 `onDraft` 的行为
