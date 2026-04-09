import { describe, expect, it, vi } from "vitest";
import { QqGateway } from "../../packages/adapters/qq/src/qq-gateway.js";

describe("qq gateway", () => {
  it("normalizes a c2c payload before dispatching it to the message handler", async () => {
    const gateway = new QqGateway({ accountKey: "qqbot:default" });
    const handler = vi.fn().mockResolvedValue(undefined);

    await gateway.onMessage(handler);
    await gateway.dispatchPayload({
      t: "C2C_MESSAGE_CREATE",
      d: {
        id: "msg-1",
        content: "hello",
        timestamp: "2026-04-09T10:00:00.000Z",
        author: {
          user_openid: "OPENID123"
        }
      }
    });

    expect(handler).toHaveBeenCalledWith({
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      senderId: "OPENID123",
      text: "hello",
      receivedAt: "2026-04-09T10:00:00.000Z"
    });
  });

  it("normalizes a group payload before dispatching it to the message handler", async () => {
    const gateway = new QqGateway({ accountKey: "qqbot:default" });
    const handler = vi.fn().mockResolvedValue(undefined);

    await gateway.onMessage(handler);
    await gateway.dispatchPayload({
      t: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "msg-2",
        content: "@bot hi",
        timestamp: "2026-04-09T10:00:01.000Z",
        group_openid: "GROUP001",
        author: {
          member_openid: "MEMBER001"
        }
      }
    });

    expect(handler).toHaveBeenCalledWith({
      messageId: "msg-2",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:group:GROUP001",
      peerKey: "qq:group:GROUP001",
      chatType: "group",
      senderId: "MEMBER001",
      text: "@bot hi",
      receivedAt: "2026-04-09T10:00:01.000Z"
    });
  });

  it("ignores unsupported event types without dispatching a message", async () => {
    const gateway = new QqGateway({ accountKey: "qqbot:default" });
    const handler = vi.fn().mockResolvedValue(undefined);

    await gateway.onMessage(handler);
    await gateway.dispatchPayload({
      t: "GUILD_MESSAGE_CREATE",
      d: {
        id: "msg-3",
        content: "ignored",
        timestamp: "2026-04-09T10:00:02.000Z"
      }
    } as never);

    expect(handler).not.toHaveBeenCalled();
  });
});
