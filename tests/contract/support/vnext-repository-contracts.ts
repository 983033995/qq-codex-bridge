import { beforeEach, afterEach, describe, expect, it } from "vitest";
import type {
  ConversationSpace,
  Delivery,
  InboundEnvelope,
  ThreadBinding,
  Turn
} from "../../../packages/domain/src/vnext/index.js";
import type {
  ConversationSpaceRepository,
  DeliveryRepository,
  MessageLedger,
  PushRepository,
  RoutingDecisionRepository,
  RuntimeEventRepository,
  ThreadBindingRepository,
  TurnRepository
} from "../../../packages/ports/src/vnext/index.js";

export type RepositoryPortHarness = {
  spaces: ConversationSpaceRepository;
  bindings: ThreadBindingRepository;
  messages: MessageLedger;
  turns: TurnRepository;
  decisions: RoutingDecisionRepository;
  deliveries: DeliveryRepository;
  pushes: PushRepository;
  events: RuntimeEventRepository;
  close(): void;
};

export function repositoryPortContract(
  name: string,
  createHarness: () => RepositoryPortHarness
): void {
  describe(`${name} repository contracts`, () => {
    let harness: RepositoryPortHarness;

    beforeEach(() => {
      harness = createHarness();
    });

    afterEach(() => {
      harness.close();
    });

    it("round-trips conversation spaces with deterministic cursor pagination", async () => {
      const spaces = [sampleSpace("c"), sampleSpace("a"), sampleSpace("b")];
      for (const space of spaces) {
        await harness.spaces.save(space);
      }

      const first = await harness.spaces.list({ limit: 2 });
      expect(first.items.map((space) => space.providerConversationId)).toEqual(["a", "b"]);
      expect(first.nextCursor).toBeTruthy();

      const second = await harness.spaces.list({ limit: 2, cursor: first.nextCursor! });
      expect(second.items.map((space) => space.providerConversationId)).toEqual(["c"]);
      expect(second.nextCursor).toBeNull();
      expect(await harness.spaces.get(spaces[0]!.spaceId)).toEqual(spaces[0]);
      await expect(harness.spaces.list({ limit: 0 })).rejects.toThrow(
        "Page limit must be an integer between 1 and 200"
      );
    });

    it("enforces active and exclusive binding invariants while allowing shared bindings", async () => {
      const spaceA = sampleSpace("a");
      const spaceB = sampleSpace("b");
      const spaceC = sampleSpace("c");
      const spaceD = sampleSpace("d");
      await saveSpaces(harness.spaces, spaceA, spaceB, spaceC, spaceD);

      const sharedA = sampleBinding("binding-a", spaceA, "thread-shared", "shared");
      const sharedB = sampleBinding("binding-b", spaceB, "thread-shared", "shared");
      await harness.bindings.save(sharedA);
      await harness.bindings.save(sharedB);
      expect(await harness.bindings.listActiveByThread("thread-shared")).toEqual([
        sharedA,
        sharedB
      ]);

      await expect(
        harness.bindings.save(
          sampleBinding("binding-exclusive", spaceC, "thread-shared", "exclusive")
        )
      ).rejects.toMatchObject({ code: "BINDING_CONFLICT" });

      await harness.bindings.save(
        sampleBinding("binding-exclusive-first", spaceC, "thread-exclusive", "exclusive")
      );
      await expect(
        harness.bindings.save(
          sampleBinding("binding-shared-second", spaceD, "thread-exclusive", "shared")
        )
      ).rejects.toMatchObject({ code: "BINDING_CONFLICT" });

      await expect(
        harness.bindings.save(sampleBinding("binding-space-conflict", spaceA, "thread-other"))
      ).rejects.toMatchObject({ code: "BINDING_CONFLICT" });

      expect(await harness.bindings.detach(sharedA.bindingId, "2026-08-10T06:01:00.000Z")).toBe(true);
      const replacement = sampleBinding("binding-replacement", spaceA, "thread-other");
      await harness.bindings.save(replacement);
      expect(await harness.bindings.getActiveBySpace(spaceA.spaceId)).toEqual(replacement);
    });

    it("deduplicates inbound messages without hiding unrelated primary-key conflicts", async () => {
      const space = sampleSpace("messages");
      await harness.spaces.save(space);
      const message = sampleMessage("message-1", space, 1);

      expect(await harness.messages.appendInbound(message, "dedupe-1")).toBe(true);
      expect(
        await harness.messages.appendInbound(
          sampleMessage("message-duplicate", space, 2),
          "dedupe-1"
        )
      ).toBe(false);
      expect(await harness.messages.findByDedupeKey("dedupe-1")).toEqual(message);

      await expect(
        harness.messages.appendInbound({ ...message, providerMessageId: "different" }, "dedupe-2")
      ).rejects.toThrow();
    });

    it("paginates equal-time messages by their stable id tie-breaker", async () => {
      const space = sampleSpace("message-page");
      await harness.spaces.save(space);
      for (const id of ["message-c", "message-a", "message-b"]) {
        await harness.messages.appendInbound(
          sampleMessage(id, space, 1, "2026-08-10T06:00:00.000Z"),
          `dedupe-${id}`
        );
      }

      const first = await harness.messages.listBySpace({ spaceId: space.spaceId, limit: 2 });
      expect(first.items.map((message) => message.messageId)).toEqual(["message-a", "message-b"]);
      const second = await harness.messages.listBySpace({
        spaceId: space.spaceId,
        limit: 2,
        cursor: first.nextCursor!
      });
      expect(second.items.map((message) => message.messageId)).toEqual(["message-c"]);
      await expect(
        harness.messages.listBySpace({ spaceId: space.spaceId, limit: 2, cursor: "not-json" })
      ).rejects.toThrow();
    });

    it("round-trips turns and identifies active and restart-recoverable work", async () => {
      const space = sampleSpace("turns");
      await harness.spaces.save(space);
      const messages = [1, 2, 3, 4].map((sequence) =>
        sampleMessage(`message-${sequence}`, space, sequence)
      );
      for (const message of messages) {
        await harness.messages.appendInbound(message, `dedupe-${message.messageId}`);
      }
      const queued = sampleTurn("turn-queued", messages[0]!, "queued");
      const running = sampleTurn("turn-running", messages[1]!, "running");
      const unknown = sampleTurn("turn-unknown", messages[2]!, "unknown");
      const completed = sampleTurn("turn-completed", messages[3]!, "completed");
      await harness.turns.save(queued);
      await harness.turns.save(running);
      await harness.turns.save(unknown);
      await harness.turns.save(completed);

      expect(await harness.turns.get(running.turnId)).toEqual(running);
      expect((await harness.turns.listActiveByThread("thread-turns")).map((turn) => turn.turnId))
        .toEqual(["turn-queued", "turn-running", "turn-unknown"]);
      expect((await harness.turns.listRecoverable()).map((turn) => turn.turnId))
        .toEqual(["turn-running", "turn-unknown"]);
    });

    it("round-trips routing decisions and delivery state", async () => {
      const space = sampleSpace("decision");
      const message = sampleMessage("message-decision", space, 1);
      await harness.spaces.save(space);
      await harness.messages.appendInbound(message, "dedupe-decision");

      await harness.decisions.save({
        decisionId: "decision-1",
        spaceId: space.spaceId,
        messageId: message.messageId,
        decision: {
          kind: "control",
          action: { type: "thread.rename", title: "Renamed" },
          confidence: 0.98,
          providerRequestId: "router-request-1"
        },
        latencyMs: 12,
        confirmationStatus: "pending",
        result: null,
        createdAt: "2026-08-10T06:00:00.000Z"
      });
      await harness.decisions.save({
        decisionId: "decision-2",
        spaceId: space.spaceId,
        messageId: message.messageId,
        decision: {
          kind: "control",
          actions: [{ type: "thread.current" }, { type: "model.current" }],
          confidence: 1
        },
        latencyMs: 1,
        confirmationStatus: "not_required",
        result: "control:completed:2",
        createdAt: "2026-08-10T06:00:01.000Z"
      });
      const decisionPage = await harness.decisions.list({ limit: 10 });
      expect(decisionPage.items).toEqual([
        expect.objectContaining({
          decisionId: "decision-1",
          decision: expect.objectContaining({
            kind: "control",
            action: { type: "thread.rename", title: "Renamed" }
          })
        }),
        expect.objectContaining({
          decisionId: "decision-2",
          decision: expect.objectContaining({
            kind: "control",
            actions: [{ type: "thread.current" }, { type: "model.current" }]
          })
        })
      ]);

      const delivery: Delivery = {
        deliveryId: "delivery-1",
        deliveryKey: "delivery-key-1",
        spaceId: space.spaceId,
        status: "pending",
        providerMessageId: null,
        attempts: 0,
        errorCode: null,
        nextAttemptAt: null,
        createdAt: "2026-08-10T06:00:00.000Z",
        updatedAt: "2026-08-10T06:00:00.000Z"
      };
      const content = { text: "recoverable reply", mentions: [], attachments: [] };
      await harness.deliveries.save(delivery, content);
      const retryWait: Delivery = {
        ...delivery,
        status: "retry_wait",
        attempts: 1,
        errorCode: "CHANNEL_DELIVERY_FAILED",
        nextAttemptAt: "2026-08-10T06:00:30.000Z",
        updatedAt: "2026-08-10T06:00:01.000Z"
      };
      await harness.deliveries.save(retryWait);
      expect(await harness.deliveries.listRecoverable({ limit: 10 })).toEqual([{
        delivery: retryWait,
        content
      }]);
      const delivered: Delivery = {
        ...delivery,
        status: "delivered",
        providerMessageId: "provider-out-1",
        attempts: 1,
        updatedAt: "2026-08-10T06:01:00.000Z"
      };
      await harness.deliveries.save(delivered);
      expect(await harness.deliveries.get(delivery.deliveryId)).toEqual(delivered);
      expect(await harness.deliveries.findByKey(delivery.deliveryKey)).toEqual(delivered);
    });

    it("round-trips push targets/jobs with idempotent enqueue semantics", async () => {
      const space = sampleSpace("push");
      const disabledSpace = sampleSpace("push-disabled");
      await harness.spaces.save(space);
      await harness.spaces.save(disabledSpace);
      await harness.pushes.saveTarget({
        alias: "owner",
        spaceId: space.spaceId,
        enabled: true,
        createdAt: "2026-08-10T06:00:00.000Z",
        updatedAt: "2026-08-10T06:00:00.000Z"
      });
      expect(await harness.pushes.getTarget("owner")).toEqual({
        alias: "owner",
        spaceId: space.spaceId,
        enabled: true,
        createdAt: "2026-08-10T06:00:00.000Z",
        updatedAt: "2026-08-10T06:00:00.000Z"
      });
      await harness.pushes.saveTarget({
        alias: "disabled",
        spaceId: disabledSpace.spaceId,
        enabled: false,
        createdAt: "2026-08-10T06:00:00.000Z",
        updatedAt: "2026-08-10T06:00:00.000Z"
      });
      expect((await harness.pushes.listTargets()).map((target) => target.alias)).toEqual(["owner"]);

      const job = {
        pushId: "push-1",
        idempotencyKey: "push-key-1",
        targetAlias: "owner",
        status: "queued" as const,
        contentJson: JSON.stringify({ text: "hello" }),
        attemptCount: 0,
        nextAttemptAt: null,
        createdAt: "2026-08-10T06:00:00.000Z",
        updatedAt: "2026-08-10T06:00:00.000Z"
      };
      expect(await harness.pushes.enqueue(job)).toEqual({ job, duplicate: false });
      expect(await harness.pushes.enqueue({ ...job, pushId: "push-2" })).toEqual({
        job,
        duplicate: true
      });
      expect(await harness.pushes.getJob(job.pushId)).toEqual(job);
    });

    it("round-trips runtime events with cursor pagination", async () => {
      for (const eventId of ["event-c", "event-a", "event-b"]) {
        await harness.events.append({
          eventId,
          component: "test",
          type: "test.event",
          payloadJson: JSON.stringify({ eventId }),
          createdAt: "2026-08-10T06:00:00.000Z"
        });
      }
      const first = await harness.events.list({ limit: 2 });
      expect(first.items.map((event) => event.eventId)).toEqual(["event-a", "event-b"]);
      const second = await harness.events.list({ limit: 2, cursor: first.nextCursor! });
      expect(second.items.map((event) => event.eventId)).toEqual(["event-c"]);
      expect(second.nextCursor).toBeNull();
    });
  });
}

export function sampleSpace(providerConversationId: string): ConversationSpace {
  const accountId = "weixin:personal" as ConversationSpace["accountId"];
  return {
    spaceId: `${accountId}::c2c:${providerConversationId}` as ConversationSpace["spaceId"],
    channel: "weixin",
    accountId,
    providerConversationId,
    scope: "c2c",
    displayName: providerConversationId,
    status: "active",
    lastInboundAt: null,
    lastOutboundAt: null
  };
}

export function sampleBinding(
  bindingId: string,
  space: ConversationSpace,
  threadId: string,
  mode: ThreadBinding["mode"] = "exclusive"
): ThreadBinding {
  return {
    bindingId,
    spaceId: space.spaceId,
    threadId,
    threadTitle: threadId,
    mode,
    status: "active",
    createdAt: "2026-08-10T06:00:00.000Z",
    updatedAt: "2026-08-10T06:00:00.000Z"
  };
}

export function sampleMessage(
  messageId: string,
  space: ConversationSpace,
  receivedSequence: number,
  receivedAt = `2026-08-10T06:00:0${receivedSequence}.000Z`
): InboundEnvelope {
  return {
    messageId,
    providerMessageId: `provider-${messageId}`,
    spaceId: space.spaceId,
    senderId: "sender-1",
    receivedSequence,
    receivedAt,
    content: { text: messageId, mentions: [], attachments: [] }
  };
}

function sampleTurn(
  turnId: string,
  message: InboundEnvelope,
  status: Turn["status"]
): Turn {
  return {
    turnId,
    threadId: "thread-turns",
    spaceId: message.spaceId,
    inboundMessageId: message.messageId,
    status,
    transport: "app-server",
    errorCode: null,
    queuedAt: message.receivedAt,
    startedAt: status === "queued" ? null : message.receivedAt,
    completedAt: status === "completed" ? message.receivedAt : null
  };
}

async function saveSpaces(
  repository: ConversationSpaceRepository,
  ...spaces: ConversationSpace[]
): Promise<void> {
  for (const space of spaces) {
    await repository.save(space);
  }
}
