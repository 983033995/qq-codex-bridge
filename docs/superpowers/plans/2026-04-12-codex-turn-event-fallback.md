# Codex 主动回调桥接兜底发送 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为所有 QQ 会话增加 Codex 驱动层主动回调 bridge daemon 的 turn event 兜底链路，解决长任务尾段回复丢失。

**Architecture:** 保留现有 `onDraft` 主链路，同时新增 `onTurnEvent` 并行侧路。`codex-desktop-driver` 负责观察并上报 `turn.delta` / `turn.completed`，bridge daemon 与 orchestrator 负责接收、去重、差量补发和最终收尾。

**Tech Stack:** TypeScript、Node.js HTTP Server、Vitest、Codex Desktop CDP、SQLite 持久化、QQ Bot OpenAPI

---

## File Structure

- `docs/superpowers/specs/2026-04-12-codex-turn-event-fallback-design.md`
  已确认的设计文档。
- `packages/domain/src/message.ts`
  补充 turn event 领域类型。
- `packages/ports/src/conversation.ts`
  扩展 `ConversationRunOptions`，支持 `onTurnEvent`。
- `packages/adapters/codex-desktop/src/codex-desktop-driver.ts`
  生成并派发 `turn.delta` / `turn.completed`。
- `apps/bridge-daemon/src/http-server.ts`
  新增内部 turn event HTTP 接口工厂。
- `apps/bridge-daemon/src/main.ts`
  装配内部 turn event 接口。
- `packages/orchestrator/src/bridge-orchestrator.ts`
  增加 turn state、幂等、差量补发和 completed 收尾。
- `tests/unit/bridge-orchestrator.test.ts`
  覆盖 turn state 收尾和补发。
- `tests/contract/codex-desktop-driver.contract.test.ts`
  覆盖 turn event 事件序列。
- `tests/unit/http-server.test.ts`
  覆盖内部回调接口只接收本地 POST JSON。

### Task 1: 定义 Turn Event 模型与端口

**Files:**
- Modify: `packages/domain/src/message.ts`
- Modify: `packages/ports/src/conversation.ts`
- Test: `tests/unit/turn-event-types.test.ts`

- [ ] **Step 1: 写失败测试，固定 turn event 结构**

```ts
import { describe, expect, it } from "vitest";
import { TurnEventType, type TurnEvent } from "../../packages/domain/src/message.js";

describe("turn event model", () => {
  it("supports delta and completed events with stable keys", () => {
    const event: TurnEvent = {
      sessionKey: "qqbot:default::qq:c2c:123",
      turnId: "turn-1",
      sequence: 2,
      eventType: TurnEventType.Delta,
      createdAt: "2026-04-12T00:00:00.000Z",
      isFinal: false,
      payload: {
        text: "第二段",
        fullText: "第一段第二段",
        mediaReferences: []
      }
    };

    expect(event.eventType).toBe(TurnEventType.Delta);
    expect(event.payload.fullText).toContain("第一段");
  });
});
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm test tests/unit/turn-event-types.test.ts`
Expected: FAIL，提示 `TurnEventType` 或 `TurnEvent` 未定义。

- [ ] **Step 3: 最小实现 turn event 类型与端口扩展**

```ts
export enum TurnEventType {
  Delta = "turn.delta",
  Status = "turn.status",
  Completed = "turn.completed"
}

export type TurnEvent = {
  sessionKey: string;
  turnId: string;
  sequence: number;
  eventType: TurnEventType;
  createdAt: string;
  isFinal: boolean;
  payload: {
    text?: string;
    fullText?: string;
    mediaReferences?: string[];
    replyToMessageId?: string;
    status?: string;
    completionReason?: "stable" | "timeout_flush";
  };
};
```

- [ ] **Step 4: 回归测试**

Run: `pnpm test tests/unit/turn-event-types.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/domain/src/message.ts packages/ports/src/conversation.ts tests/unit/turn-event-types.test.ts
git commit -m "feat: add turn event domain model"
```

### Task 2: 为 Codex Driver 增加 turn event 事件序列

**Files:**
- Modify: `packages/adapters/codex-desktop/src/codex-desktop-driver.ts`
- Test: `tests/contract/codex-desktop-driver.contract.test.ts`

- [ ] **Step 1: 写失败测试，验证 driver 会发 delta 与 completed**

```ts
it("emits turn events while collecting assistant reply", async () => {
  const events: TurnEvent[] = [];
  const drafts = await driver.collectAssistantReply(binding, {
    onTurnEvent: async (event) => {
      events.push(event);
    }
  });

  expect(drafts).toEqual([]);
  expect(events.some((event) => event.eventType === TurnEventType.Delta)).toBe(true);
  expect(events.at(-1)?.eventType).toBe(TurnEventType.Completed);
});
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm test tests/contract/codex-desktop-driver.contract.test.ts -t "emits turn events while collecting assistant reply"`
Expected: FAIL，提示 `onTurnEvent` 未调用或事件序列不匹配。

- [ ] **Step 3: 在 driver 中生成稳定 turnId 与 sequence**

```ts
const turnId = randomUUID();
let turnSequence = 0;

const emitTurnEvent = async (event: Omit<TurnEvent, "sequence" | "turnId" | "createdAt">) => {
  if (!options.onTurnEvent) return;
  turnSequence += 1;
  await options.onTurnEvent({
    ...event,
    turnId,
    sequence: turnSequence,
    createdAt: new Date().toISOString()
  });
};
```

- [ ] **Step 4: 在 delta 与 completed 分支里发事件**

```ts
await emitTurnEvent({
  sessionKey: binding.sessionKey,
  eventType: TurnEventType.Delta,
  isFinal: false,
  payload: {
    text: deltaDraft.text,
    fullText: candidateReply.reply ?? "",
    mediaReferences: candidateReply.mediaReferences
  }
});

await emitTurnEvent({
  sessionKey: binding.sessionKey,
  eventType: TurnEventType.Completed,
  isFinal: true,
  payload: {
    fullText: candidateReply.reply ?? "",
    mediaReferences: candidateReply.mediaReferences,
    completionReason: "stable"
  }
});
```

- [ ] **Step 5: 回归测试**

Run: `pnpm test tests/contract/codex-desktop-driver.contract.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add packages/adapters/codex-desktop/src/codex-desktop-driver.ts tests/contract/codex-desktop-driver.contract.test.ts
git commit -m "feat: emit codex turn events from desktop driver"
```

### Task 3: 接入 bridge daemon 内部回调接口

**Files:**
- Modify: `apps/bridge-daemon/src/http-server.ts`
- Modify: `apps/bridge-daemon/src/main.ts`
- Test: `tests/unit/http-server.test.ts`

- [ ] **Step 1: 写失败测试，验证内部接口接收 POST turn event**

```ts
it("accepts codex turn events on the internal route", async () => {
  const payloads: unknown[] = [];
  const server = createInternalTurnEventServer({
    routePath: "/internal/codex-turn-events",
    ingress: {
      dispatchTurnEvent: async (payload) => payloads.push(payload)
    }
  });
  // 省略启动和 fetch 细节
  expect(payloads).toHaveLength(1);
});
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm test tests/unit/http-server.test.ts`
Expected: FAIL，提示内部 turn event server 不存在。

- [ ] **Step 3: 最小实现内部回调 server**

```ts
export function createInternalTurnEventServer(deps: InternalTurnEventServerDeps): Server {
  return createServer(async (request, response) => {
    if (request.socket.remoteAddress && request.socket.remoteAddress !== "127.0.0.1" && request.socket.remoteAddress !== "::1") {
      response.statusCode = 403;
      response.end("forbidden");
      return;
    }
    // 仅接受 POST + JSON，再转发到 dispatchTurnEvent
  });
}
```

- [ ] **Step 4: 在 main 中装配接口**

Run: `pnpm test tests/unit/http-server.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/bridge-daemon/src/http-server.ts apps/bridge-daemon/src/main.ts tests/unit/http-server.test.ts
git commit -m "feat: add internal codex turn event server"
```

### Task 4: 在 orchestrator 中消费 turn event 并补齐尾段

**Files:**
- Modify: `packages/orchestrator/src/bridge-orchestrator.ts`
- Test: `tests/unit/bridge-orchestrator.test.ts`

- [ ] **Step 1: 写失败测试，验证 completed 会补发缺失尾段**

```ts
it("flushes only missing tail text when completed event has a longer full text", async () => {
  await orchestrator.handleTurnEvent({
    sessionKey: session.sessionKey,
    turnId: "turn-1",
    sequence: 1,
    eventType: TurnEventType.Delta,
    createdAt: now,
    isFinal: false,
    payload: { text: "前半段", fullText: "前半段" }
  });

  await orchestrator.handleTurnEvent({
    sessionKey: session.sessionKey,
    turnId: "turn-1",
    sequence: 2,
    eventType: TurnEventType.Completed,
    createdAt: now,
    isFinal: true,
    payload: { fullText: "前半段后半段", completionReason: "stable" }
  });

  expect(deliver).toHaveBeenNthCalledWith(2, expect.objectContaining({ text: "后半段" }));
});
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm test tests/unit/bridge-orchestrator.test.ts -t "flushes only missing tail text when completed event has a longer full text"`
Expected: FAIL，提示 `handleTurnEvent` 不存在或未补发尾段。

- [ ] **Step 3: 实现 turn state 与差量补发**

```ts
type TurnState = {
  lastSequence: number;
  assembledText: string;
  sentTextLength: number;
  completed: boolean;
  finalFlushed: boolean;
  lastEventAt: string;
};
```

- [ ] **Step 4: completed 分支做 final flush**

```ts
const pendingText = state.assembledText.slice(state.sentTextLength);
if (pendingText) {
  await this.deps.qqEgress.deliver({
    draftId: randomUUID(),
    sessionKey: event.sessionKey,
    text: pendingText,
    createdAt: event.createdAt
  });
  state.sentTextLength = state.assembledText.length;
}
state.completed = true;
state.finalFlushed = true;
```

- [ ] **Step 5: 回归测试**

Run: `pnpm test tests/unit/bridge-orchestrator.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add packages/orchestrator/src/bridge-orchestrator.ts tests/unit/bridge-orchestrator.test.ts
git commit -m "feat: flush missing tail text from turn events"
```

### Task 5: 全量验证与收尾

**Files:**
- Modify: `README.md`（仅当实现中需要补说明时）

- [ ] **Step 1: 运行类型检查**

Run: `pnpm run check`
Expected: PASS

- [ ] **Step 2: 运行全量测试**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 3: 运行 GitNexus 提交前检查**

Run: staged `gitnexus_detect_changes({ scope: "staged" })`
Expected: `risk_level: low` 或与改动范围一致

- [ ] **Step 4: 提交最终实现**

```bash
git add .
git commit -m "feat: add codex turn event fallback delivery"
```
