import { describe, expect, it } from "vitest";
import {
  ReconcileRecoverableTurns,
  ThreadScheduler
} from "../../packages/application/src/index.js";
import type {
  ConversationSpaceId,
  Turn
} from "../../packages/domain/src/vnext/index.js";
import {
  ControllableCodexPort,
  FixedClock,
  MemoryRuntimeEventRepository,
  MemoryTurnRepository,
  SequenceIdGenerator
} from "../support/vnext-fakes.js";

describe("vNext ThreadScheduler", () => {
  it("runs each Thread in FIFO order while allowing three Threads globally", async () => {
    const harness = createScheduler({ maxParallel: 3 });
    const firstA = controlledWork("a1");
    const secondA = controlledWork("a2");
    const firstB = controlledWork("b1");
    const firstC = controlledWork("c1");
    const firstD = controlledWork("d1");

    const taskA1 = await harness.scheduler.enqueue(task("a1", "space-a", "thread-a", 1, firstA));
    const taskA2 = await harness.scheduler.enqueue(task("a2", "space-a", "thread-a", 2, secondA));
    const taskB1 = await harness.scheduler.enqueue(task("b1", "space-b", "thread-b", 1, firstB));
    const taskC1 = await harness.scheduler.enqueue(task("c1", "space-c", "thread-c", 1, firstC));
    const taskD1 = await harness.scheduler.enqueue(task("d1", "space-d", "thread-d", 1, firstD));

    await Promise.all([firstA.started, firstB.started, firstC.started]);
    expect(secondA.hasStarted()).toBe(false);
    expect(firstD.hasStarted()).toBe(false);
    expect(harness.scheduler.snapshot()).toMatchObject({ running: 3, queued: 2 });

    firstA.complete();
    await expect(taskA1.completion).resolves.toBe("a1");
    await secondA.started;
    expect(firstD.hasStarted()).toBe(false);

    firstB.complete();
    await expect(taskB1.completion).resolves.toBe("b1");
    await firstD.started;

    secondA.complete();
    firstC.complete();
    firstD.complete();
    await Promise.all([
      expect(taskA2.completion).resolves.toBe("a2"),
      expect(taskC1.completion).resolves.toBe("c1"),
      expect(taskD1.completion).resolves.toBe("d1")
    ]);
    expect(harness.scheduler.snapshot()).toMatchObject({ running: 0, queued: 0 });
  });

  it("rejects stale or duplicate Space sequence numbers", async () => {
    const { scheduler } = createScheduler();
    const accepted = await scheduler.enqueue({
      ...task("first", "space-a", "thread-a", 2, controlledWork("first")),
      work: async () => "first"
    });
    await expect(accepted.completion).resolves.toBe("first");

    await expect(scheduler.enqueue({
      ...task("duplicate", "space-a", "thread-a", 2, controlledWork("duplicate")),
      work: async () => "duplicate"
    })).rejects.toMatchObject({ code: "MESSAGE_SEQUENCE_CONFLICT" });
    await expect(scheduler.enqueue({
      ...task("stale", "space-a", "thread-a", 1, controlledWork("stale")),
      work: async () => "stale"
    })).rejects.toMatchObject({ code: "MESSAGE_SEQUENCE_CONFLICT" });
  });

  it("serializes one Space even when its binding changes to another Thread", async () => {
    const { scheduler } = createScheduler({ maxParallel: 3 });
    const beforeSwitch = controlledWork("before-switch");
    const afterSwitch = controlledWork("after-switch");
    const first = await scheduler.enqueue(
      task("before-switch", "space-a", "thread-a", 1, beforeSwitch)
    );
    await beforeSwitch.started;
    const second = await scheduler.enqueue(
      task("after-switch", "space-a", "thread-b", 2, afterSwitch)
    );
    expect(afterSwitch.hasStarted()).toBe(false);

    beforeSwitch.complete();
    await first.completion;
    await afterSwitch.started;
    afterSwitch.complete();
    await second.completion;
  });

  it("enforces Thread and global queue limits with explicit errors", async () => {
    const { scheduler } = createScheduler({
      maxParallel: 1,
      maxQueuedPerThread: 1,
      maxQueuedGlobal: 1
    });
    const running = controlledWork("running");
    const queued = controlledWork("queued");
    const runningTask = await scheduler.enqueue(task("running", "space-a", "thread-a", 1, running));
    await running.started;
    const queuedTask = await scheduler.enqueue(task("queued", "space-a", "thread-a", 2, queued));

    await expect(scheduler.enqueue(
      task("thread-full", "space-a", "thread-a", 3, controlledWork("thread-full"))
    )).rejects.toMatchObject({
      code: "CODEX_TURN_QUEUE_FULL",
      details: { scope: "thread", limit: 1 }
    });
    await expect(scheduler.enqueue(
      task("global-full", "space-b", "thread-b", 1, controlledWork("global-full"))
    )).rejects.toMatchObject({
      code: "CODEX_TURN_QUEUE_FULL",
      details: { scope: "global", limit: 1 }
    });

    await queuedTask.cancel();
    await expect(queuedTask.completion).rejects.toMatchObject({ code: "CODEX_TURN_CANCELLED" });
    running.complete();
    await runningTask.completion;
  });

  it("emits ordered queue events and never starts a cancelled task", async () => {
    const { scheduler, events } = createScheduler({ maxParallel: 1 });
    const running = controlledWork("running");
    const cancelled = controlledWork("cancelled");
    const runningTask = await scheduler.enqueue(task("running", "space-a", "thread-a", 1, running));
    await running.started;
    const cancelledTask = await scheduler.enqueue(
      task("cancelled", "space-a", "thread-a", 2, cancelled)
    );
    await cancelledTask.cancel();
    await expect(cancelledTask.completion).rejects.toMatchObject({ code: "CODEX_TURN_CANCELLED" });
    expect(cancelled.hasStarted()).toBe(false);

    running.complete();
    await runningTask.completion;
    expect(events.values.map((event) => event.type)).toEqual([
      "turn.queue.queued",
      "turn.queue.started",
      "turn.queue.queued",
      "turn.queue.cancelled",
      "turn.queue.completed"
    ]);
  });

  it("interrupts running work and classifies the terminal event", async () => {
    const { scheduler, events } = createScheduler();
    const work = controlledWork("interruptible");
    const scheduled = await scheduler.enqueue({
      ...task("interruptible", "space-a", "thread-a", 1, work),
      interrupt: async () => work.fail(new Error("remote interrupted"))
    });
    await work.started;

    await expect(scheduled.interrupt()).resolves.toBe(true);
    await expect(scheduled.completion).rejects.toThrow("remote interrupted");
    expect(events.values.map((event) => event.type)).toEqual([
      "turn.queue.queued",
      "turn.queue.started",
      "turn.queue.interrupted"
    ]);
  });

  it("releases the global slot after failure so later work can start", async () => {
    const { scheduler } = createScheduler({ maxParallel: 1 });
    const first = controlledWork("first");
    const second = controlledWork("second");
    const firstTask = await scheduler.enqueue(task("first", "space-a", "thread-a", 1, first));
    const secondTask = await scheduler.enqueue(task("second", "space-b", "thread-b", 1, second));
    await first.started;
    first.fail(new Error("boom"));
    await expect(firstTask.completion).rejects.toThrow("boom");
    await second.started;
    second.complete();
    await expect(secondTask.completion).resolves.toBe("second");
  });
});

describe("vNext recoverable Turn reconciliation", () => {
  it("marks inherited work unknown before resolving real AppServer Turn states", async () => {
    const turns = new MemoryTurnRepository();
    const events = new MemoryRuntimeEventRepository();
    const codex = new ControllableCodexPort(false);
    const thread = await codex.createThread({ title: "Recovery" });
    const runningHandle = await codex.startTurn(codexInput(thread.threadId, "running"));
    const completedHandle = await codex.startTurn(codexInput(thread.threadId, "completed"));
    const interruptedHandle = await codex.startTurn(codexInput(thread.threadId, "interrupted"));
    void runningHandle.completion.catch(() => undefined);
    void completedHandle.completion.catch(() => undefined);
    void interruptedHandle.completion.catch(() => undefined);
    codex.complete(completedHandle.turnId);
    await codex.interruptTurn(thread.threadId, interruptedHandle.turnId);

    for (const [turnId, status] of [
      [runningHandle.turnId, "running"],
      [completedHandle.turnId, "starting"],
      [interruptedHandle.turnId, "running"],
      ["missing-turn", "starting"]
    ] as const) {
      await turns.save(sampleRecoverableTurn(turnId, thread.threadId, status));
    }

    const reconciler = new ReconcileRecoverableTurns({
      turns,
      codex,
      events,
      ids: new SequenceIdGenerator("recovery-event"),
      clock: new FixedClock("2026-08-10T07:00:00.000Z")
    });
    const resolutions = await reconciler.execute();

    expect(resolutions.map(({ turn, remoteStatus }) => [turn.turnId, turn.status, remoteStatus]))
      .toEqual([
        [runningHandle.turnId, "unknown", "running"],
        [completedHandle.turnId, "completed", "completed"],
        [interruptedHandle.turnId, "interrupted", "interrupted"],
        ["missing-turn", "failed", "not_found"]
      ]);
    expect(await turns.get("missing-turn")).toMatchObject({
      status: "failed",
      errorCode: "CODEX_TURN_RECOVERY_FAILED"
    });
    expect(events.values.filter((event) => event.type === "turn.recovery.unknown"))
      .toHaveLength(4);
    expect((await turns.listActiveByThread(thread.threadId)).map((turn) => turn.turnId))
      .toEqual([runningHandle.turnId]);
  });
});

function createScheduler(options: {
  maxParallel?: number;
  maxQueuedPerThread?: number;
  maxQueuedGlobal?: number;
} = {}) {
  const events = new MemoryRuntimeEventRepository();
  return {
    events,
    scheduler: new ThreadScheduler({
      events,
      ids: new SequenceIdGenerator("scheduler-event"),
      clock: new FixedClock(),
      ...options
    })
  };
}

function task(
  taskId: string,
  space: string,
  threadId: string,
  receivedSequence: number,
  work: ReturnType<typeof controlledWork>
) {
  return {
    taskId,
    spaceId: `weixin:personal::c2c:${space}` as ConversationSpaceId,
    threadId,
    receivedSequence,
    work: work.run
  };
}

function controlledWork(value: string) {
  let started = false;
  let resolveStarted!: () => void;
  let resolve!: (value: string) => void;
  let reject!: (error: unknown) => void;
  const startedPromise = new Promise<void>((resolvePromise) => {
    resolveStarted = resolvePromise;
  });
  const completion = new Promise<string>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void completion.catch(() => undefined);
  return {
    started: startedPromise,
    hasStarted: () => started,
    run: async () => {
      started = true;
      resolveStarted();
      return completion;
    },
    complete: () => resolve(value),
    fail: (error: unknown) => reject(error)
  };
}

function codexInput(threadId: string, idempotencyKey: string) {
  return {
    threadId,
    idempotencyKey,
    content: { text: idempotencyKey, mentions: [], attachments: [] }
  };
}

function sampleRecoverableTurn(
  turnId: string,
  threadId: string,
  status: "starting" | "running"
): Turn {
  return {
    turnId,
    threadId,
    spaceId: "weixin:personal::c2c:recovery" as ConversationSpaceId,
    inboundMessageId: `message-${turnId}`,
    status,
    transport: "app-server",
    errorCode: null,
    queuedAt: "2026-08-10T06:00:00.000Z",
    startedAt: "2026-08-10T06:00:01.000Z",
    completedAt: null
  };
}
