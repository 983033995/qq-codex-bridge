import { describe, expect, it } from "vitest";
import { normalizeC2CMessage } from "../../packages/adapters/qq/src/qq-normalizer.js";

describe("qq normalizer", () => {
  it("maps a c2c event to the bridge inbound model", () => {
    const inbound = normalizeC2CMessage(
      {
        id: "msg-1",
        content: "hello",
        timestamp: "2026-04-08T10:00:00.000Z",
        author: {
          user_openid: "ABC123"
        }
      },
      "qqbot:default"
    );

    expect(inbound.peerKey).toBe("qq:c2c:ABC123");
    expect(inbound.sessionKey).toBe("qqbot:default::qq:c2c:ABC123");
  });
});
