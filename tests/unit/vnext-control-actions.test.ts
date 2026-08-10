import { describe, expect, it } from "vitest";
import {
  BindConversationSpace,
  EnqueuePush,
  ExecuteControlAction,
  RunHealthCheck
} from "../../packages/application/src/index.js";
import type {
  ConversationSpace,
  ThreadBinding,
  Turn
} from "../../packages/domain/src/vnext/index.js";
import {
  ControllableCodexPort,
  FixedClock,
  MemoryConversationSpaceRepository,
  MemoryPushRepository,
  MemoryThreadBindingRepository,
  MemoryTurnRepository,
  SequenceIdGenerator
} from "../support/vnext-fakes.js";

describe("vNext ExecuteControlAction", () => {
  it("executes deterministic thread query and mutation actions", async () => {
    const harness = await createHarness();
    const threadA = await harness.codex.createThread({ title: "Thread A" });
    const threadB = await harness.codex.createThread({ title: "Thread B" });
    await harness.bind.execute({ spaceId: harness.space.spaceId, thread: threadA });

    await expect(harness.execute.execute({
      spaceId: harness.space.spaceId,
      action: { type: "thread.list" }
    })).resolves.toMatchObject({ status: "completed", message: "Threads listed" });
    await expect(harness.execute.execute({
      spaceId: harness.space.spaceId,
      action: { type: "thread.current" }
    })).resolves.toMatchObject({
      status: "completed",
      data: { threadId: threadA.threadId }
    });

    await harness.execute.execute({
      spaceId: harness.space.spaceId,
      action: { type: "thread.switch", target: { kind: "id", threadId: threadB.threadId } }
    });
    expect((await harness.bindings.getActiveBySpace(harness.space.spaceId))?.threadId)
      .toBe(threadB.threadId);

    await harness.execute.execute({
      spaceId: harness.space.spaceId,
      action: { type: "thread.create", title: "Created C" }
    });
    let current = (await harness.bindings.getActiveBySpace(harness.space.spaceId))!;
    expect(current.threadTitle).toBe("Created C");

    await harness.execute.execute({
      spaceId: harness.space.spaceId,
      action: { type: "thread.rename", title: "Renamed C" }
    });
    current = (await harness.bindings.getActiveBySpace(harness.space.spaceId))!;
    expect(current.threadTitle).toBe("Renamed C");
    expect(harness.codex.threads.find((thread) => thread.threadId === current.threadId)?.title)
      .toBe("Renamed C");

    await harness.execute.execute({
      spaceId: harness.space.spaceId,
      action: { type: "thread.fork", title: "Forked D" }
    });
    current = (await harness.bindings.getActiveBySpace(harness.space.spaceId))!;
    expect(current.threadTitle).toBe("Forked D");
    expect(current.threadId).not.toBe(threadA.threadId);
    expect(current.threadId).not.toBe(threadB.threadId);
  });

  it("fails explicitly for ambiguous or missing thread selectors", async () => {
    const harness = await createHarness();
    await harness.codex.createThread({ title: "Duplicate" });
    await harness.codex.createThread({ title: "Duplicate" });

    await expect(harness.execute.execute({
      spaceId: harness.space.spaceId,
      action: { type: "thread.switch", target: { kind: "title", title: "duplicate" } }
    })).rejects.toMatchObject({ code: "ROUTER_AMBIGUOUS" });
    await expect(harness.execute.execute({
      spaceId: harness.space.spaceId,
      action: { type: "thread.switch", target: { kind: "index", index: 0 } }
    })).rejects.toMatchObject({ code: "CODEX_THREAD_NOT_FOUND" });
  });

  it("never executes model changes, interruption, or push without confirmation", async () => {
    const harness = await createHarness();
    const thread = await harness.codex.createThread({ title: "Current" });
    await harness.bind.execute({ spaceId: harness.space.spaceId, thread });
    await harness.pushes.saveTarget({
      alias: "owner",
      spaceId: harness.space.spaceId,
      enabled: true,
      createdAt: harness.clock.now().toISOString(),
      updatedAt: harness.clock.now().toISOString()
    });

    for (const action of [
      { type: "model.switch", model: "next-model" } as const,
      { type: "turn.interrupt" } as const,
      { type: "push.send", target: "owner", content: "hello" } as const
    ]) {
      await expect(harness.execute.execute({
        spaceId: harness.space.spaceId,
        action,
        requestId: "request-1"
      })).resolves.toMatchObject({
        status: "confirmation_required",
        risk: "high",
        action
      });
    }
    expect((await harness.codex.getControlState()).model).toBe("fake-model");
    expect(harness.pushes.jobs.size).toBe(0);

    await harness.execute.execute({
      spaceId: harness.space.spaceId,
      action: { type: "model.switch", model: "next-model" },
      confirmed: true
    });
    expect((await harness.codex.getControlState()).model).toBe("next-model");

    const pushResult = await harness.execute.execute({
      spaceId: harness.space.spaceId,
      action: { type: "push.send", target: "owner", content: "hello" },
      confirmed: true,
      requestId: "request-1"
    });
    expect(pushResult).toMatchObject({
      status: "completed",
      data: { duplicate: false, job: { idempotencyKey: expect.stringContaining("request-1") } }
    });
  });

  it("interrupts a running turn only after confirmation and persists interruption", async () => {
    const harness = await createHarness();
    const thread = await harness.codex.createThread({ title: "Running" });
    await harness.bind.execute({ spaceId: harness.space.spaceId, thread });
    const handle = await harness.codex.startTurn({
      threadId: thread.threadId,
      idempotencyKey: "message-1",
      content: { text: "hello", mentions: [], attachments: [] }
    });
    void handle.completion.catch(() => undefined);
    const turn: Turn = {
      turnId: handle.turnId,
      threadId: thread.threadId,
      spaceId: harness.space.spaceId,
      inboundMessageId: "message-1",
      status: "running",
      transport: "app-server",
      errorCode: null,
      queuedAt: handle.acceptedAt,
      startedAt: handle.acceptedAt,
      completedAt: null
    };
    await harness.turns.save(turn);

    await harness.execute.execute({
      spaceId: harness.space.spaceId,
      action: { type: "turn.interrupt" },
      confirmed: true
    });
    expect(await harness.turns.get(turn.turnId)).toMatchObject({
      status: "interrupted",
      completedAt: harness.clock.now().toISOString()
    });
  });

  it("returns enabled push targets, aggregate system health, and the closed action list", async () => {
    const harness = await createHarness();
    await harness.pushes.saveTarget({
      alias: "enabled",
      spaceId: harness.space.spaceId,
      enabled: true,
      createdAt: harness.clock.now().toISOString(),
      updatedAt: harness.clock.now().toISOString()
    });
    await harness.pushes.saveTarget({
      alias: "disabled",
      spaceId: harness.space.spaceId,
      enabled: false,
      createdAt: harness.clock.now().toISOString(),
      updatedAt: harness.clock.now().toISOString()
    });

    await expect(harness.execute.execute({
      spaceId: harness.space.spaceId,
      action: { type: "push.targets" }
    })).resolves.toMatchObject({ data: [{ alias: "enabled" }] });
    await expect(harness.execute.execute({
      spaceId: harness.space.spaceId,
      action: { type: "system.status" }
    })).resolves.toMatchObject({ data: { status: "ready" } });
    const help = await harness.execute.execute({
      spaceId: harness.space.spaceId,
      action: { type: "help" }
    });
    expect(help).toMatchObject({ status: "completed" });
    expect((help as { data: string[] }).data).toHaveLength(15);
  });
});

async function createHarness(): Promise<{
  space: ConversationSpace;
  clock: FixedClock;
  codex: ControllableCodexPort;
  bindings: MemoryThreadBindingRepository;
  turns: MemoryTurnRepository;
  pushes: MemoryPushRepository;
  bind: BindConversationSpace;
  execute: ExecuteControlAction;
}> {
  const space = sampleSpace();
  const clock = new FixedClock();
  const codex = new ControllableCodexPort(false);
  const spaces = new MemoryConversationSpaceRepository();
  const bindings = new MemoryThreadBindingRepository();
  const turns = new MemoryTurnRepository();
  const pushes = new MemoryPushRepository();
  await spaces.save(space);
  const bind = new BindConversationSpace({
    spaces,
    bindings,
    codex,
    ids: new SequenceIdGenerator("binding"),
    clock
  });
  const enqueuePush = new EnqueuePush({
    pushes,
    ids: new SequenceIdGenerator("push"),
    clock
  });
  const runHealthCheck = new RunHealthCheck({
    clock,
    probes: [{
      component: "codex",
      critical: true,
      check: () => codex.health()
    }]
  });
  return {
    space,
    clock,
    codex,
    bindings,
    turns,
    pushes,
    bind,
    execute: new ExecuteControlAction({
      codex,
      bindings,
      turns,
      pushes,
      bindConversationSpace: bind,
      enqueuePush,
      runHealthCheck,
      clock
    })
  };
}

function sampleSpace(): ConversationSpace {
  const accountId = "weixin:personal" as ConversationSpace["accountId"];
  return {
    spaceId: `${accountId}::c2c:owner` as ConversationSpace["spaceId"],
    channel: "weixin",
    accountId,
    providerConversationId: "owner",
    scope: "c2c",
    displayName: "Owner",
    status: "active",
    lastInboundAt: null,
    lastOutboundAt: null
  };
}
