import { describe, expect, it } from "vitest";
import { BridgeSessionStatus } from "../../packages/domain/src/session.js";
import type { InboundMessage } from "../../packages/domain/src/message.js";

describe("domain contracts", () => {
  it("exposes bridge session statuses and inbound chat types", () => {
    const sample: InboundMessage = {
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:abc",
      peerKey: "qq:c2c:abc",
      chatType: "c2c",
      senderId: "abc",
      text: "hello",
      receivedAt: "2026-04-08T10:00:00.000Z"
    };

    expect(BridgeSessionStatus.Active).toBe("active");
    expect(sample.chatType).toBe("c2c");
  });
});
