import { describe, expect, it } from "vitest";
import { buildPeerKey, buildSessionKey } from "../../packages/orchestrator/src/session-key.js";

describe("group session isolation", () => {
  it("uses one group one session", () => {
    const peerKey = buildPeerKey({ chatType: "group", peerId: "GROUP-1" });
    const sessionKey = buildSessionKey({ accountKey: "qqbot:default", peerKey });

    expect(peerKey).toBe("qq:group:GROUP-1");
    expect(sessionKey).toBe("qqbot:default::qq:group:GROUP-1");
  });
});
