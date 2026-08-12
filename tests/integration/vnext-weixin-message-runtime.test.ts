import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BindConversationSpace,
  ReceiveInboundMessage,
  StartConversationTurn,
  ThreadScheduler
} from "../../packages/application/src/index.js";
import { WeixinDeliveryError } from "../../packages/channel-weixin/src/index.js";
import { transitionDelivery } from "../../packages/domain/src/vnext/index.js";
import {
  SqliteConversationSpaceRepository,
  SqliteDeliveryRepository,
  SqliteMessageLedger,
  SqliteRuntimeEventRepository,
  SqliteThreadBindingRepository,
  SqliteTurnRepository,
  openVNextDatabase,
  type SqliteDatabase
} from "../../packages/store-sqlite/src/index.js";
import { WeixinMessageRuntime } from "../../apps/control-daemon/src/index.js";
import {
  ControllableCodexPort,
  FixedClock,
  SequenceIdGenerator
} from "../support/vnext-fakes.js";

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("vNext Weixin message runtime", () => {
  it("uses the same durable pipeline for a Feishu text message", async () => {
    const fixture = createFixture();
    const runtime = fixture.runtime({
      async deliver(input) { return `sent:${input.peerId}`; }
    }, undefined, "feishu");
    const execution = runtime.handle({
      ...inbound("feishu-provider-1"),
      accountId: "feishu:default",
      attachments: []
    });
    await fixture.codex.waitForStartCount(1);
    expect(fixture.codex.starts[0]!.input.idempotencyKey).toMatch(/^feishu-[a-f0-9]{64}$/);
    fixture.codex.complete(fixture.codex.starts[0]!.handle.turnId, "feishu reply");
    await expect(execution).resolves.toMatchObject({
      message: { spaceId: "feishu:default::c2c:peer-1" },
      delivery: { status: "delivered", providerMessageId: "sent:peer-1" }
    });
  });

  it("persists, deduplicates, binds, runs Codex, and delivers one stable reply", async () => {
    const fixture = createFixture();
    const deliveries: unknown[] = [];
    const runtime = fixture.runtime({
      async deliver(input) {
        deliveries.push(input);
        return input.deliveryKey;
      }
    });

    const execution = runtime.handle(inbound());
    await fixture.codex.waitForStartCount(1);
    expect(fixture.codex.starts[0]!.input).toMatchObject({
      idempotencyKey: expect.stringMatching(/^weixin-[a-f0-9]{64}$/),
      content: {
        text: "hello",
        mentions: [],
        attachments: [expect.objectContaining({ id: "attachment-inbound-1", kind: "image" })]
      }
    });
    fixture.codex.complete(fixture.codex.starts[0]!.handle.turnId, "assistant reply");
    const result = await execution;

    expect(result).toMatchObject({
      duplicate: false,
      delivery: {
        status: "delivered",
        attempts: 1,
        providerMessageId: expect.stringContaining(":assistant-final")
      }
    });
    expect(deliveries).toContainEqual(expect.objectContaining({
      deliveryKey: result.delivery!.deliveryKey,
      accountId: "weixin:personal",
      peerId: "peer-1",
      text: "assistant reply"
    }));
    expect(await fixture.bindings.getActiveBySpace(result.message.spaceId)).toMatchObject({
      threadTitle: "微信 · peer-1",
      mode: "exclusive"
    });
    expect(await fixture.spaces.get(result.message.spaceId)).toMatchObject({
      lastInboundAt: "2026-08-11T00:00:01.000Z",
      lastOutboundAt: "2026-08-10T06:00:00.000Z"
    });
    expect((await fixture.messages.listBySpace({ spaceId: result.message.spaceId, limit: 10 })).items[0])
      .toMatchObject({
        content: {
          attachments: [expect.objectContaining({ localPath: "/tmp/weixin-image.jpg" })]
        }
      });

    await expect(runtime.handle(inbound())).resolves.toMatchObject({
      duplicate: true,
      delivery: { status: "delivered", deliveryKey: result.delivery!.deliveryKey }
    });
    expect(fixture.codex.starts).toHaveLength(1);
    expect(deliveries).toHaveLength(1);
  });

  it("delivers a routed control reply without starting a Codex turn", async () => {
    const fixture = createFixture();
    const deliveries: Array<{ deliveryKey: string; text: string }> = [];
    const runtime = fixture.runtime({
      async deliver(input) {
        deliveries.push(input);
        return input.deliveryKey;
      }
    }, undefined, "weixin", {
      route: {
        async execute() {
          return { kind: "reply" as const, text: "当前线程：vNext 开发" };
        }
      }
    });

    await expect(runtime.handle(inbound("provider-control-route"))).resolves.toMatchObject({
      delivery: { status: "delivered" }
    });
    expect(fixture.codex.starts).toHaveLength(0);
    expect(deliveries).toEqual([
      expect.objectContaining({
        deliveryKey: expect.stringContaining(":assistant-final"),
        text: "当前线程：vNext 开发"
      })
    ]);
  });

  it("sends bounded progress updates and keeps the final reply independent of progress failures", async () => {
    const fixture = createFixture();
    const keys: string[] = [];
    const progressErrors: Error[] = [];
    const runtime = fixture.runtime({
      async deliver(input) {
        keys.push(input.deliveryKey);
        if (input.deliveryKey.endsWith(":progress:2")) {
          throw new Error("progress channel unavailable");
        }
        return input.deliveryKey;
      }
    }, undefined, "weixin", {
      progress: { heartbeatIntervalMs: 5, maxUpdates: 2 },
      onProgressError(error) { progressErrors.push(error); }
    });

    const execution = runtime.handle(inbound("provider-progress"));
    await fixture.codex.waitForStartCount(1);
    await eventually(() => keys.some((key) => key.endsWith(":progress:2")));
    fixture.codex.complete(fixture.codex.starts[0]!.handle.turnId, "final after progress");
    await expect(execution).resolves.toMatchObject({ delivery: { status: "delivered" } });

    expect(keys.filter((key) => key.includes(":progress:"))).toHaveLength(2);
    expect(keys.at(-1)).toContain(":assistant-final");
    expect(progressErrors).toHaveLength(1);
  });

  it("persists a permanent authentication failure without exposing reply content", async () => {
    const fixture = createFixture();
    const runtime = fixture.runtime({
      async deliver() {
        throw new WeixinDeliveryError("WEIXIN_NOT_LOGGED_IN", false, "not logged in");
      }
    });

    const execution = runtime.handle(inbound());
    await fixture.codex.waitForStartCount(1);
    fixture.codex.complete(fixture.codex.starts[0]!.handle.turnId, "sensitive reply");
    await expect(execution).rejects.toMatchObject({ code: "WEIXIN_NOT_LOGGED_IN", retryable: false });

    const spaceId = "weixin:personal::c2c:peer-1" as never;
    const ledger = await fixture.messages.listBySpace({ spaceId, limit: 10 });
    const delivery = await fixture.deliveries.findByKey(`${ledger.items[0]!.messageId}:assistant-final`);
    expect(delivery).toMatchObject({
      status: "failed",
      attempts: 1,
      errorCode: "CHANNEL_AUTH_REQUIRED",
      providerMessageId: null
    });
    expect(JSON.stringify(delivery)).not.toContain("sensitive reply");
  });

  it("delivers local Codex media references and explicitly reports rejected URLs", async () => {
    const fixture = createFixture();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vnext-weixin-runtime-media-"));
    const imagePath = path.join(root, "result.png");
    fs.writeFileSync(imagePath, Buffer.from("generated-image"));
    const deliveries: Array<{ text: string; attachments?: Array<{ localPath: string; kind: string }> }> = [];
    const runtime = fixture.runtime({
      async deliver(input) {
        deliveries.push(input);
        return input.deliveryKey;
      }
    });

    const execution = runtime.handle(inbound("provider-inbound-media"));
    await fixture.codex.waitForStartCount(1);
    fixture.codex.complete(
      fixture.codex.starts[0]!.handle.turnId,
      "媒体回复",
      [imagePath, "https://example.test/not-downloaded.png"]
    );
    await expect(execution).resolves.toMatchObject({ delivery: { status: "delivered" } });
    expect(deliveries).toContainEqual(expect.objectContaining({
      text: expect.stringContaining("1 个媒体附件未发送"),
      attachments: [expect.objectContaining({ localPath: fs.realpathSync(imagePath), kind: "image" })]
    }));
  });

  it("ACKs after SQLite persistence and deduplicates a redelivery while processing continues", async () => {
    const fixture = createFixture();
    const runtime = fixture.runtime({ async deliver(input) { return input.deliveryKey; } });

    await runtime.accept(inbound("provider-ack-window"));
    const spaceId = "weixin:personal::c2c:peer-1" as never;
    expect((await fixture.messages.listBySpace({ spaceId, limit: 10 })).items).toHaveLength(1);
    await fixture.codex.waitForStartCount(1);

    await runtime.accept(inbound("provider-ack-window"));
    expect(fixture.codex.starts).toHaveLength(1);
    fixture.codex.complete(fixture.codex.starts[0]!.handle.turnId, "reply after ack");
    await eventually(async () => {
      const messages = await fixture.messages.listBySpace({ spaceId, limit: 10 });
      const delivery = await fixture.deliveries.findByKey(`${messages.items[0]!.messageId}:assistant-final`);
      return delivery?.status === "delivered";
    });
  });

  it("recovers a crash-claimed delivery with the same key after a 429", async () => {
    const fixture = createFixture();
    const keys: string[] = [];
    let rateLimited = true;
    const worker = {
      async deliver(input: { deliveryKey: string }) {
        keys.push(input.deliveryKey);
        if (rateLimited) {
          rateLimited = false;
          throw new WeixinDeliveryError("WEIXIN_RATE_LIMITED", true, "HTTP 429");
        }
        return "provider-recovered";
      }
    };
    const runtime = fixture.runtime(worker, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 });
    const execution = runtime.handle(inbound("provider-retry-429"));
    await fixture.codex.waitForStartCount(1);
    fixture.codex.complete(fixture.codex.starts[0]!.handle.turnId, "retry reply");
    await expect(execution).rejects.toMatchObject({ code: "WEIXIN_RATE_LIMITED", retryable: true });

    const spaceId = "weixin:personal::c2c:peer-1" as never;
    const message = (await fixture.messages.listBySpace({ spaceId, limit: 10 })).items[0]!;
    let delivery = (await fixture.deliveries.findByKey(`${message.messageId}:assistant-final`))!;
    expect(delivery).toMatchObject({ status: "retry_wait", attempts: 1 });
    fixture.clock.set(delivery.nextAttemptAt!);
    delivery = transitionDelivery(delivery, "sending", { at: fixture.clock.now().toISOString() });
    await fixture.deliveries.save(delivery);

    const restarted = fixture.runtime(worker, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 });
    await restarted.recoverDeliveries();
    expect(await fixture.deliveries.get(delivery.deliveryId)).toMatchObject({
      status: "delivered",
      attempts: 2,
      providerMessageId: "provider-recovered"
    });
    expect(keys).toEqual([delivery.deliveryKey, delivery.deliveryKey]);
  });

  it("bounds repeated 5xx recovery attempts and marks the delivery failed", async () => {
    const fixture = createFixture();
    let calls = 0;
    const worker = {
      async deliver() {
        calls += 1;
        throw new WeixinDeliveryError("WEIXIN_HTTP_ERROR", true, "HTTP 503");
      }
    };
    const runtime = fixture.runtime(worker, { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 100 });
    const execution = runtime.handle(inbound("provider-retry-503"));
    await fixture.codex.waitForStartCount(1);
    fixture.codex.complete(fixture.codex.starts[0]!.handle.turnId, "bounded reply");
    await expect(execution).rejects.toMatchObject({ code: "WEIXIN_HTTP_ERROR" });

    const spaceId = "weixin:personal::c2c:peer-1" as never;
    const message = (await fixture.messages.listBySpace({ spaceId, limit: 10 })).items[0]!;
    let delivery = (await fixture.deliveries.findByKey(`${message.messageId}:assistant-final`))!;
    fixture.clock.set(delivery.nextAttemptAt!);
    await runtime.recoverDeliveries();
    delivery = (await fixture.deliveries.get(delivery.deliveryId))!;
    expect(delivery).toMatchObject({ status: "failed", attempts: 2, nextAttemptAt: null });
    await runtime.recoverDeliveries();
    expect(calls).toBe(2);
  });
});

function createFixture() {
  const database = openVNextDatabase(":memory:");
  databases.push(database);
  const spaces = new SqliteConversationSpaceRepository(database);
  const bindings = new SqliteThreadBindingRepository(database);
  const messages = new SqliteMessageLedger(database);
  const turns = new SqliteTurnRepository(database);
  const deliveries = new SqliteDeliveryRepository(database);
  const events = new SqliteRuntimeEventRepository(database);
  const codex = new ControllableCodexPort(false);
  const clock = new FixedClock();
  const receive = new ReceiveInboundMessage({ spaces, messages });
  const bind = new BindConversationSpace({
    spaces,
    bindings,
    codex,
    ids: new SequenceIdGenerator("binding"),
    clock
  });
  const startTurn = new StartConversationTurn({
    bindings,
    turns,
    codex,
    ids: new SequenceIdGenerator("failed-turn"),
    clock,
    scheduler: new ThreadScheduler({
      events,
      ids: new SequenceIdGenerator("scheduler-event"),
      clock
    })
  });
  return {
    spaces,
    bindings,
    messages,
    deliveries,
    clock,
    codex,
    runtime(worker: { deliver(input: {
      deliveryKey: string;
      accountId: string;
      peerId: string;
      chatType: "c2c" | "group";
      text: string;
      attachments?: Array<{
        id: string;
        kind: "image" | "audio" | "video" | "file";
        localPath: string;
        mimeType: string;
        size: number;
        name?: string;
      }>;
    }): Promise<string | null> }, retry?: {
      maxAttempts?: number;
      baseDelayMs?: number;
      maxDelayMs?: number;
    }, channel: "weixin" | "feishu" = "weixin", options?: {
      route?: { execute(space: unknown, message: unknown): Promise<
        { kind: "chat" } | { kind: "reply"; text: string }
      > };
      progress?: { heartbeatIntervalMs?: number; maxUpdates?: number };
      onProgressError?(error: Error): void;
    }) {
      return new WeixinMessageRuntime({
        channel,
        spaces,
        deliveries,
        receive,
        bind,
        startTurn,
        worker,
        ids: new SequenceIdGenerator("delivery"),
        clock,
        ...(options?.route ? { route: options.route as never } : {}),
        ...(options?.progress ? { progress: options.progress } : {}),
        ...(options?.onProgressError ? { onProgressError: options.onProgressError } : {}),
        ...(retry ? { retry } : {})
      });
    }
  };
}

function inbound(providerMessageId = "provider-inbound-1") {
  return {
    accountId: "weixin:personal",
    providerMessageId,
    senderId: "peer-1",
    peerId: "peer-1",
    chatType: "c2c" as const,
    sequence: 1,
    receivedAt: "2026-08-11T00:00:01.000Z",
    text: "hello",
    attachments: [{
      id: "attachment-inbound-1",
      kind: "image" as const,
      localPath: "/tmp/weixin-image.jpg",
      mimeType: "image/jpeg",
      size: 10,
      name: "weixin-image.jpg"
    }]
  };
}

async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
