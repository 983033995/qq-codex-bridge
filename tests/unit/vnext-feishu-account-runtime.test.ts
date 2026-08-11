import { describe, expect, it, vi } from "vitest";
import type { InboundMessage } from "../../packages/domain/src/message.js";
import { MemorySecretStore } from "../../packages/config/src/index.js";
import { FeishuAccountRuntime } from "../../apps/control-daemon/src/feishu-account-runtime.js";

describe("vNext Feishu account runtime", () => {
  it("validates credentials, starts ingress, accepts inbound, and delivers a reply", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("feishu/default", "secret");
    let handler: ((message: InboundMessage) => Promise<void>) | null = null;
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const deliver = vi.fn(async () => ({ providerMessageId: "feishu-out-1" }));
    const inbound: unknown[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request) => String(url).includes("tenant_access_token")
      ? new Response(JSON.stringify({ code: 0, tenant_access_token: "token", expire: 7200 }), { status: 200 })
      : new Response(JSON.stringify({ code: 0, bot: { app_name: "script", open_id: "bot-id" } }), { status: 200 }));
    const runtime = new FeishuAccountRuntime({
      accountId: "default",
      appId: "app-id",
      secretRef: "feishu/default",
      secrets,
      fetchFn: fetchFn as typeof fetch,
      createAdapter: (() => ({
        ingress: {
          onMessage(next: (message: InboundMessage) => Promise<void>) { handler = next; },
          start,
          stop
        },
        egress: { deliver },
        pushEgress: {}
      })) as never,
      async onInbound(message) { inbound.push(message); }
    });

    await runtime.start();
    await expect(runtime.health()).resolves.toMatchObject({ status: "ready" });
    await expect(runtime.test()).resolves.toMatchObject({ ok: true, botName: "script" });
    expect(start).toHaveBeenCalledOnce();

    const receive = handler as unknown as (message: InboundMessage) => Promise<void>;
    await receive({
      messageId: "feishu-in-1",
      accountKey: "feishu:default",
      sessionKey: "feishu:default::fs:c2c:chat-1",
      peerKey: "fs:c2c:chat-1",
      chatType: "c2c",
      senderId: "user-1",
      text: "hello",
      receivedAt: "2026-08-11T00:00:00.000Z"
    });
    expect(inbound).toEqual([expect.objectContaining({
      accountId: "feishu:default",
      providerMessageId: "feishu-in-1",
      peerId: "chat-1",
      text: "hello"
    })]);
    await expect(runtime.deliver({
      deliveryKey: "delivery-1",
      accountId: "feishu:default",
      peerId: "chat-1",
      chatType: "c2c",
      text: "reply"
    })).resolves.toBe("feishu-out-1");
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      draftId: expect.stringMatching(/^[a-f0-9]{32}$/),
      sessionKey: "feishu:default::fs:c2c:chat-1",
      text: "reply"
    }));
    await runtime.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("reports invalid credentials as degraded without crashing the daemon", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("feishu/default", "wrong-secret");
    const runtime = new FeishuAccountRuntime({
      accountId: "default",
      appId: "app-id",
      secretRef: "feishu/default",
      secrets,
      fetchFn: async () => new Response(JSON.stringify({ code: 10003 }), { status: 200 }),
      createAdapter: vi.fn() as never,
      async onInbound() {}
    });

    await runtime.start();
    await expect(runtime.health()).resolves.toMatchObject({
      status: "degraded",
      code: "FEISHU_RUNTIME_NOT_READY"
    });
    await expect(runtime.test()).rejects.toThrow("飞书凭据验证失败");
  });
});
