import { describe, expect, it } from "vitest";
import type {
  ChannelPort,
  CodexPort,
  DeliveryRequest,
  SecretStorePort
} from "../../../packages/ports/src/vnext/index.js";
import type { InboundEnvelope } from "../../../packages/domain/src/vnext/index.js";

export type ChannelPortHarness = {
  port: ChannelPort;
  emitInbound(message: InboundEnvelope): Promise<void>;
  deliveries: DeliveryRequest[];
};

export function channelPortContract(
  name: string,
  createHarness: () => ChannelPortHarness
): void {
  describe(`${name} ChannelPort contract`, () => {
    it("delivers inbound messages to the registered handler", async () => {
      const harness = createHarness();
      const received: InboundEnvelope[] = [];
      harness.port.onMessage(async (message) => {
        received.push(message);
      });
      const sample = sampleInboundEnvelope();

      await harness.port.start();
      await harness.emitInbound(sample);
      await harness.port.stop();

      expect(received).toEqual([sample]);
    });

    it("reports health and records idempotent delivery keys", async () => {
      const harness = createHarness();
      await harness.port.start();
      expect((await harness.port.health()).status).toBe("ready");

      const delivery = sampleDeliveryRequest();
      expect(await harness.port.deliver(delivery)).toEqual({
        ok: true,
        providerMessageId: "provider-out-1"
      });
      expect(harness.deliveries).toEqual([delivery]);
      await harness.port.stop();
    });
  });
}

export function codexPortContract(name: string, createPort: () => CodexPort): void {
  describe(`${name} CodexPort contract`, () => {
    it("creates, lists, renames, and forks real thread ids", async () => {
      const port = createPort();
      const created = await port.createThread({ title: "Thread A" });
      expect(created.threadId).toBeTruthy();
      expect((await port.listThreads({ limit: 10 })).map((thread) => thread.threadId)).toContain(
        created.threadId
      );

      await port.renameThread(created.threadId, "Renamed A");
      expect((await port.listThreads({ limit: 10 }))[0]?.title).toBe("Renamed A");
      const forked = await port.forkThread(created.threadId);
      expect(forked.threadId).not.toBe(created.threadId);
    });

    it("returns an accepted turn handle and supports interruption", async () => {
      const port = createPort();
      const thread = await port.createThread({ title: "Thread A" });
      const handle = await port.startTurn({
        threadId: thread.threadId,
        idempotencyKey: "turn-key-1",
        content: { text: "hello", mentions: [], attachments: [] }
      });
      expect(handle.threadId).toBe(thread.threadId);
      await port.interruptTurn(handle.threadId, handle.turnId);
      await handle.completion.then(
        () => undefined,
        () => undefined
      );
    });
  });
}

export function secretStorePortContract(
  name: string,
  createStore: () => SecretStorePort
): void {
  describe(`${name} SecretStorePort contract`, () => {
    it("round-trips, overwrites, and deletes a secret reference", async () => {
      const store = createStore();
      expect(await store.get("router/default")).toBeNull();
      await store.set("router/default", "secret-a");
      expect(await store.get("router/default")).toBe("secret-a");
      await store.set("router/default", "secret-b");
      expect(await store.get("router/default")).toBe("secret-b");
      await store.delete("router/default");
      expect(await store.get("router/default")).toBeNull();
    });
  });
}

function sampleInboundEnvelope(): InboundEnvelope {
  return {
    messageId: "message-1",
    providerMessageId: "provider-in-1",
    spaceId: "weixin:personal::c2c:wxid_1" as InboundEnvelope["spaceId"],
    senderId: "sender-1",
    receivedSequence: 1,
    receivedAt: "2026-08-10T06:00:00.000Z",
    content: { text: "hello", mentions: [], attachments: [] }
  };
}

function sampleDeliveryRequest(): DeliveryRequest {
  return {
    deliveryKey: "delivery-key-1",
    accountId: "weixin:personal" as DeliveryRequest["accountId"],
    spaceId: "weixin:personal::c2c:wxid_1" as DeliveryRequest["spaceId"],
    content: { text: "reply", mentions: [], attachments: [] }
  };
}
