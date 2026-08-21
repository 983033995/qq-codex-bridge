import { describe, expect, it, vi } from "vitest";
import { QqAccountRuntime } from "../../apps/control-daemon/src/qq-account-runtime.js";
import { MemorySecretStore } from "../../packages/config/src/index.js";
import type { InboundMessage, OutboundDraft } from "../../packages/domain/src/message.js";

describe("QqAccountRuntime", () => {
  it("normalizes legacy QQ messages for the vNext runtime and replies to the provider message", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("channel/qq/main", "secret");
    let handler: ((message: InboundMessage) => Promise<void>) | null = null;
    const delivered: OutboundDraft[] = [];
    const inbounds: unknown[] = [];
    const runtime = new QqAccountRuntime({
      accountId: "main",
      appId: "app-id",
      secretRef: "channel/qq/main",
      dataDirectory: "/tmp/omniagent-qq-test",
      secrets,
      onInbound: async (message) => { inbounds.push(message); },
      createConnection: () => ({
        test: vi.fn(async () => {}),
        adapter: {
          ingress: {
            async onMessage(next) { handler = next; },
            async start() {},
            async stop() {}
          },
          egress: {
            async deliver(draft) {
              delivered.push(draft);
              return {
                jobId: draft.draftId,
                sessionKey: draft.sessionKey,
                providerMessageId: "qq-outbound-1",
                deliveredAt: draft.createdAt
              };
            }
          }
        }
      })
    });

    await runtime.start();
    expect(await runtime.health()).toMatchObject({ status: "ready" });
    await handler!({
      messageId: "qq-inbound-1",
      accountKey: "qq:main",
      sessionKey: "qq:main::qq:c2c:user-open-id",
      peerKey: "qq:c2c:user-open-id",
      chatType: "c2c",
      senderId: "user-open-id",
      text: "重启微信",
      receivedAt: "2026-08-13T00:00:00.000Z"
    });
    expect(inbounds).toEqual([expect.objectContaining({
      accountId: "qq:main",
      providerMessageId: "qq-inbound-1",
      peerId: "user-open-id",
      text: "重启微信"
    })]);

    await expect(runtime.deliver({
      deliveryKey: "delivery-1",
      accountId: "qq:main",
      peerId: "user-open-id",
      chatType: "c2c",
      text: "已重启微信渠道。",
      replyToProviderMessageId: "qq-inbound-1"
    })).resolves.toBe("qq-outbound-1");
    expect(delivered).toEqual([expect.objectContaining({
      sessionKey: "qq:main::qq:c2c:user-open-id",
      replyToMessageId: "qq-inbound-1",
      text: "已重启微信渠道。"
    })]);
  });

  it("fails loudly when the configured secret is unavailable", async () => {
    const runtime = new QqAccountRuntime({
      accountId: "missing",
      appId: "app-id",
      secretRef: "channel/qq/missing",
      dataDirectory: "/tmp/omniagent-qq-test",
      secrets: new MemorySecretStore(),
      async onInbound() {}
    });
    await runtime.start();
    expect(await runtime.health()).toMatchObject({
      status: "degraded",
      code: "QQ_RUNTIME_NOT_READY",
      message: expect.stringContaining("不存在")
    });
  });
});
