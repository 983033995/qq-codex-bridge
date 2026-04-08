import { describe, expect, it } from "vitest";
import { buildSessionKey, buildPeerKey } from "../../packages/orchestrator/src/session-key.js";

describe("session key helpers", () => {
  it("builds c2c peer and session keys deterministically", () => {
    const peerKey = buildPeerKey({ chatType: "c2c", peerId: "ABC123" });
    const sessionKey = buildSessionKey({ accountKey: "qqbot:default", peerKey });

    expect(peerKey).toBe("qq:c2c:ABC123");
    expect(sessionKey).toBe("qqbot:default::qq:c2c:ABC123");
  });
});
