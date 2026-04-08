import { describe, expect, it, vi } from "vitest";
import { BridgeSessionStatus } from "../../packages/domain/src/session.js";
import { BridgeOrchestrator } from "../../packages/orchestrator/src/bridge-orchestrator.js";
import type { SessionStorePort } from "../../packages/ports/src/store.js";

describe("rebind recovery", () => {
  it("marks session as needs_rebind when provider fails", async () => {
    const withSessionLock: SessionStorePort["withSessionLock"] = async <T>(
      _key: string,
      work: () => Promise<T>
    ) => await work();

    const sessionStore = {
      getSession: vi.fn().mockResolvedValue({
        sessionKey: "qqbot:default::qq:c2c:abc",
        accountKey: "qqbot:default",
        peerKey: "qq:c2c:abc",
        chatType: "c2c",
        peerId: "abc",
        codexThreadRef: "codex-thread:1",
        status: BridgeSessionStatus.Active,
        lastInboundAt: null,
        lastOutboundAt: null,
        lastError: null
      }),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn().mockResolvedValue(undefined),
      updateBinding: vi.fn().mockResolvedValue(undefined),
      withSessionLock
    };

    const transcriptStore = {
      recordInbound: vi.fn().mockResolvedValue(undefined),
      recordOutbound: vi.fn().mockResolvedValue(undefined),
      hasInbound: vi.fn().mockResolvedValue(false)
    };

    const orchestrator = new BridgeOrchestrator({
      sessionStore,
      transcriptStore,
      conversationProvider: {
        runTurn: vi.fn().mockRejectedValue(new Error("reply timeout"))
      },
      qqEgress: {
        deliver: vi.fn()
      }
    });

    await expect(
      orchestrator.handleInbound({
        messageId: "qq-msg-1",
        accountKey: "qqbot:default",
        sessionKey: "qqbot:default::qq:c2c:abc",
        peerKey: "qq:c2c:abc",
        chatType: "c2c",
        senderId: "abc",
        text: "hello",
        receivedAt: "2026-04-08T10:00:00.000Z"
      })
    ).rejects.toThrow("reply timeout");

    expect(sessionStore.updateSessionStatus).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:abc",
      BridgeSessionStatus.NeedsRebind,
      "reply timeout"
    );
  });
});
