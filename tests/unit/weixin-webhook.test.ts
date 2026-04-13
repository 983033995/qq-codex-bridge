import { describe, expect, it, vi } from "vitest";
import { createWeixinChannelAdapter } from "../../packages/adapters/weixin/src/weixin-channel-adapter.js";
import { normalizeWeixinInboundMessage } from "../../packages/adapters/weixin/src/weixin-webhook.js";

describe("weixin webhook normalization", () => {
  it("normalizes a c2c webhook payload into inbound message", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T08:00:00.000Z"));

    try {
      const message = normalizeWeixinInboundMessage(
        {
          senderId: "wxid_sender",
          peerId: "wxid_peer",
          messageId: "msg-1",
          text: "你好"
        },
        {
          accountKey: "weixin:default"
        }
      );

      expect(message).toEqual({
        messageId: "msg-1",
        accountKey: "weixin:default",
        sessionKey: "weixin:default::wx:c2c:wxid_peer",
        peerKey: "wx:c2c:wxid_peer",
        chatType: "c2c",
        senderId: "wxid_sender",
        text: "你好",
        receivedAt: "2026-04-13T08:00:00.000Z"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates adapter webhook parser without coupling to orchestrator", () => {
    const adapter = createWeixinChannelAdapter({
      accountKey: "weixin:test",
      webhookPath: "/webhooks/weixin",
      egressBaseUrl: "http://127.0.0.1:8080",
      egressToken: "token"
    });

    const message = adapter.webhook.toInboundMessage({
      chatType: "group",
      senderId: "wxid_sender",
      peerId: "chatroom_1",
      messageId: "msg-2",
      text: "ping",
      receivedAt: "2026-04-13T09:00:00.000+08:00"
    });

    expect(adapter.webhook.routePath).toBe("/webhooks/weixin");
    expect(message.sessionKey).toBe("weixin:test::wx:group:chatroom_1");
    expect(message.peerKey).toBe("wx:group:chatroom_1");
    expect(message.chatType).toBe("group");
  });
});
