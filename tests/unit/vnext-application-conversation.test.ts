import { describe, expect, it } from "vitest";
import {
  BindConversationSpace,
  ReceiveInboundMessage,
  StartConversationTurn,
  ThreadScheduler
} from "../../packages/application/src/index.js";
import type {
  ConversationSpace,
  InboundEnvelope,
  ThreadBinding
} from "../../packages/domain/src/vnext/index.js";
import {
  ControllableCodexPort,
  FixedClock,
  MemoryConversationSpaceRepository,
  MemoryMessageLedger,
  MemoryRuntimeEventRepository,
  MemoryThreadBindingRepository,
  MemoryTurnRepository,
  SequenceIdGenerator
} from "../support/vnext-fakes.js";

describe("vNext conversation application use cases", () => {
  it("records inbound messages once and preserves the latest inbound timestamp", async () => {
    const spaces = new MemoryConversationSpaceRepository();
    const messages = new MemoryMessageLedger();
    const receive = new ReceiveInboundMessage({ spaces, messages });
    const space = sampleSpace("inbound");
    const message = sampleMessage("message-1", space, "2026-08-10T06:01:00.000Z");

    expect(await receive.execute({ space, message })).toEqual({
      accepted: true,
      duplicate: false,
      message
    });
    const retryWithDifferentInternalId = {
      ...message,
      messageId: "message-retry"
    };
    expect(await receive.execute({ space, message: retryWithDifferentInternalId })).toEqual({
      accepted: false,
      duplicate: true,
      message
    });
    expect((await spaces.get(space.spaceId))?.lastInboundAt).toBe(message.receivedAt);
  });

  it("rejects mismatched conversation identity before writing", async () => {
    const spaces = new MemoryConversationSpaceRepository();
    const messages = new MemoryMessageLedger();
    const receive = new ReceiveInboundMessage({ spaces, messages });
    const space = sampleSpace("correct");
    const wrongSpace = sampleSpace("wrong");

    await expect(receive.execute({
      space,
      message: sampleMessage("message-1", wrongSpace)
    })).rejects.toThrow("does not match");
    expect(spaces.values.size).toBe(0);
  });

  it("creates one default exclusive thread and idempotently reuses its binding", async () => {
    const spaces = new MemoryConversationSpaceRepository();
    const bindings = new MemoryThreadBindingRepository();
    const codex = new ControllableCodexPort();
    const space = sampleSpace("owner", "负责人");
    await spaces.save(space);
    const bind = new BindConversationSpace({
      spaces,
      bindings,
      codex,
      ids: new SequenceIdGenerator("binding"),
      clock: new FixedClock()
    });

    const first = await bind.execute({ spaceId: space.spaceId });
    const second = await bind.execute({ spaceId: space.spaceId });
    expect(first).toEqual(second);
    expect(first).toMatchObject({ mode: "exclusive", status: "active" });
    expect(codex.threads).toHaveLength(1);
    expect(codex.threads[0]?.title).toBe("微信 · 负责人");
  });

  it("restores the previous binding when replacement persistence fails", async () => {
    const spaces = new MemoryConversationSpaceRepository();
    const bindings = new MemoryThreadBindingRepository();
    const codex = new ControllableCodexPort();
    const space = sampleSpace("rollback");
    await spaces.save(space);
    const originalThread = await codex.createThread({ title: "Original" });
    const replacementThread = await codex.createThread({ title: "Replacement" });
    const original = sampleBinding("binding-original", space, originalThread.threadId);
    await bindings.save(original);
    const bind = new BindConversationSpace({
      spaces,
      bindings,
      codex,
      ids: new SequenceIdGenerator("binding"),
      clock: new FixedClock()
    });
    bindings.failNextSave = new Error("database unavailable");

    await expect(bind.execute({
      spaceId: space.spaceId,
      thread: replacementThread,
      replaceActive: true
    })).rejects.toThrow("database unavailable");
    expect(await bindings.getActiveBySpace(space.spaceId)).toEqual(original);
  });

  it("runs different threads concurrently while serializing the same thread", async () => {
    const bindings = new MemoryThreadBindingRepository();
    const turns = new MemoryTurnRepository();
    const codex = new ControllableCodexPort(false);
    const threadA = await codex.createThread({ title: "A" });
    const threadB = await codex.createThread({ title: "B" });
    const spaceA = sampleSpace("a");
    const spaceB = sampleSpace("b");
    await bindings.save(sampleBinding("binding-a", spaceA, threadA.threadId));
    await bindings.save(sampleBinding("binding-b", spaceB, threadB.threadId));
    const start = new StartConversationTurn({
      bindings,
      turns,
      codex,
      ids: new SequenceIdGenerator("failed-turn"),
      clock: new FixedClock("2026-08-10T06:02:00.000Z"),
      scheduler: createScheduler()
    });

    const firstA = start.execute(sampleMessage("message-a1", spaceA, undefined, 1));
    const secondA = start.execute(sampleMessage("message-a2", spaceA, undefined, 2));
    const firstB = start.execute(sampleMessage("message-b1", spaceB));
    await codex.waitForStartCount(2);
    expect(codex.starts.map((started) => started.input.idempotencyKey).sort()).toEqual([
      "message-a1",
      "message-b1"
    ]);

    const runningA = codex.starts.find(
      (started) => started.input.idempotencyKey === "message-a1"
    )!;
    codex.complete(runningA.handle.turnId);
    await codex.waitForStartCount(3);
    expect(codex.starts[2]?.input.idempotencyKey).toBe("message-a2");
    for (const started of codex.starts.filter((candidate) => candidate !== runningA)) {
      codex.complete(started.handle.turnId);
    }

    const results = await Promise.all([firstA, secondA, firstB]);
    expect(results.map((result) => result.turn.status)).toEqual([
      "completed",
      "completed",
      "completed"
    ]);
    expect(await turns.listActiveByThread(threadA.threadId)).toEqual([]);
  });

  it("records a stable failure when Codex rejects an accepted turn", async () => {
    const bindings = new MemoryThreadBindingRepository();
    const turns = new MemoryTurnRepository();
    const codex = new ControllableCodexPort(false);
    const thread = await codex.createThread({ title: "Failure" });
    const space = sampleSpace("failure");
    await bindings.save(sampleBinding("binding-failure", space, thread.threadId));
    const start = new StartConversationTurn({
      bindings,
      turns,
      codex,
      ids: new SequenceIdGenerator("failed-turn"),
      clock: new FixedClock(),
      scheduler: createScheduler()
    });

    const execution = start.execute(sampleMessage("message-failure", space));
    await codex.waitForStartCount(1);
    codex.fail("turn-1", new Error("connection closed"));
    await expect(execution).rejects.toThrow("connection closed");
    expect(await turns.get("turn-1")).toMatchObject({
      status: "failed",
      errorCode: "CODEX_UNAVAILABLE"
    });
  });

  it("persists the degraded Recovery transport on running and completed turns", async () => {
    const bindings = new MemoryThreadBindingRepository();
    const turns = new MemoryTurnRepository();
    const space = sampleSpace("recovery-transport");
    await bindings.save(sampleBinding("binding-recovery", space, "thread-recovery"));
    const codex = {
      async startTurn(input: { threadId: string }) {
        return {
          threadId: input.threadId,
          turnId: "recovery-turn",
          acceptedAt: "2026-08-10T06:00:00.000Z",
          transport: "cdp-recovery" as const,
          completion: Promise.resolve({
            threadId: input.threadId,
            turnId: "recovery-turn",
            finalText: "recovered",
            mediaReferences: []
          })
        };
      },
      async interruptTurn() {}
    };
    const start = new StartConversationTurn({
      bindings,
      turns,
      codex,
      ids: new SequenceIdGenerator("failed-turn"),
      clock: new FixedClock(),
      scheduler: createScheduler()
    });

    const result = await start.execute(sampleMessage("message-recovery", space));
    expect(result.turn).toMatchObject({
      turnId: "recovery-turn",
      status: "completed",
      transport: "cdp-recovery"
    });
    expect(await turns.get("recovery-turn")).toMatchObject({
      status: "completed",
      transport: "cdp-recovery"
    });
  });

  it("records a local failed turn when Codex rejects submission", async () => {
    const bindings = new MemoryThreadBindingRepository();
    const turns = new MemoryTurnRepository();
    const codex = new RejectingStartCodexPort();
    const thread = await codex.createThread({ title: "Unavailable" });
    const space = sampleSpace("submission-failure");
    await bindings.save(sampleBinding("binding-submission-failure", space, thread.threadId));
    const start = new StartConversationTurn({
      bindings,
      turns,
      codex,
      ids: new SequenceIdGenerator("failed-turn"),
      clock: new FixedClock(),
      scheduler: createScheduler()
    });

    await expect(start.execute(sampleMessage("message-submission-failure", space)))
      .rejects.toThrow("submission unavailable");
    expect(await turns.get("failed-turn-1")).toMatchObject({
      status: "failed",
      errorCode: "CODEX_UNAVAILABLE",
      completedAt: "2026-08-10T06:00:00.000Z"
    });
  });

  it("does not overwrite an explicitly interrupted turn when completion rejects", async () => {
    const bindings = new MemoryThreadBindingRepository();
    const turns = new MemoryTurnRepository();
    const codex = new ControllableCodexPort(false);
    const thread = await codex.createThread({ title: "Interrupted" });
    const space = sampleSpace("interrupted");
    await bindings.save(sampleBinding("binding-interrupted", space, thread.threadId));
    const start = new StartConversationTurn({
      bindings,
      turns,
      codex,
      ids: new SequenceIdGenerator("failed-turn"),
      clock: new FixedClock(),
      scheduler: createScheduler()
    });

    const execution = start.execute(sampleMessage("message-interrupted", space));
    await codex.waitForStartCount(1);
    const running = await turns.waitForStatus("turn-1", "running");
    await turns.save({
      ...running,
      status: "interrupted",
      completedAt: "2026-08-10T06:01:00.000Z"
    });
    codex.fail("turn-1", new Error("interrupted"));

    await expect(execution).rejects.toThrow("interrupted");
    expect(await turns.get("turn-1")).toMatchObject({
      status: "interrupted",
      completedAt: "2026-08-10T06:01:00.000Z"
    });
  });

  it("interrupts accepted Codex work through the shared scheduler", async () => {
    const bindings = new MemoryThreadBindingRepository();
    const turns = new MemoryTurnRepository();
    const codex = new ControllableCodexPort(false);
    const scheduler = createScheduler();
    const thread = await codex.createThread({ title: "Scheduler interrupt" });
    const space = sampleSpace("scheduler-interrupt");
    await bindings.save(sampleBinding("binding-scheduler-interrupt", space, thread.threadId));
    const start = new StartConversationTurn({
      bindings,
      turns,
      codex,
      ids: new SequenceIdGenerator("failed-turn"),
      clock: new FixedClock(),
      scheduler
    });

    const execution = start.execute(sampleMessage("message-scheduler-interrupt", space));
    await codex.waitForStartCount(1);
    await turns.waitForStatus("turn-1", "running");
    await expect(scheduler.interruptThread(thread.threadId)).resolves.toBe(true);
    await expect(execution).rejects.toThrow("interrupted");
    expect(await turns.get("turn-1")).toMatchObject({ status: "interrupted" });
    await expect(codex.getTurnStatus(thread.threadId, "turn-1")).resolves.toBe("interrupted");
  });
});

function sampleSpace(
  providerConversationId: string,
  displayName = providerConversationId
): ConversationSpace {
  const accountId = "weixin:personal" as ConversationSpace["accountId"];
  return {
    spaceId: `${accountId}::c2c:${providerConversationId}` as ConversationSpace["spaceId"],
    channel: "weixin",
    accountId,
    providerConversationId,
    scope: "c2c",
    displayName,
    status: "active",
    lastInboundAt: null,
    lastOutboundAt: null
  };
}

function sampleMessage(
  messageId: string,
  space: ConversationSpace,
  receivedAt = "2026-08-10T06:00:00.000Z",
  receivedSequence = 1
): InboundEnvelope {
  return {
    messageId,
    providerMessageId: `provider-${messageId.replace(/^message-retry$/, "message-1")}`,
    spaceId: space.spaceId,
    senderId: "sender-1",
    receivedSequence,
    receivedAt,
    content: { text: messageId, mentions: [], attachments: [] }
  };
}

function createScheduler(): ThreadScheduler {
  return new ThreadScheduler({
    events: new MemoryRuntimeEventRepository(),
    ids: new SequenceIdGenerator("scheduler-event"),
    clock: new FixedClock()
  });
}

function sampleBinding(
  bindingId: string,
  space: ConversationSpace,
  threadId: string
): ThreadBinding {
  return {
    bindingId,
    spaceId: space.spaceId,
    threadId,
    threadTitle: threadId,
    mode: "exclusive",
    status: "active",
    createdAt: "2026-08-10T06:00:00.000Z",
    updatedAt: "2026-08-10T06:00:00.000Z"
  };
}

class RejectingStartCodexPort extends ControllableCodexPort {
  override async startTurn(
    _input: Parameters<ControllableCodexPort["startTurn"]>[0]
  ): Promise<never> {
    throw new Error("submission unavailable");
  }
}
