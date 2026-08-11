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
    }): Promise<string | null> }) {
      return new WeixinMessageRuntime({
        spaces,
        deliveries,
        receive,
        bind,
        startTurn,
        worker,
        ids: new SequenceIdGenerator("delivery"),
        clock
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
