import { describe, expect, it, vi } from "vitest";
import { BridgeSessionStatus } from "../../packages/domain/src/session.js";
import type { BridgeSession } from "../../packages/domain/src/session.js";
import { DesktopDriverError } from "../../packages/domain/src/driver.js";
import type { InboundMessage, OutboundDraft } from "../../packages/domain/src/message.js";
import type { ConversationProviderPort } from "../../packages/ports/src/conversation.js";
import type { QqEgressPort } from "../../packages/ports/src/qq.js";
import type { SessionStorePort, TranscriptStorePort } from "../../packages/ports/src/store.js";
import { BridgeOrchestrator } from "../../packages/orchestrator/src/bridge-orchestrator.js";
import { deliverDrafts } from "../../packages/orchestrator/src/job-runner.js";

function createMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: "msg-1",
    accountKey: "qqbot:default",
    sessionKey: "qqbot:default::qq:c2c:abc-123",
    peerKey: "qq:c2c:abc-123",
    chatType: "c2c",
    senderId: "abc-123",
    text: "hello",
    receivedAt: "2026-04-08T10:00:00.000Z",
    ...overrides
  };
}

function createSession(message: InboundMessage): BridgeSession {
  return {
    sessionKey: message.sessionKey,
    accountKey: message.accountKey,
    peerKey: message.peerKey,
    chatType: message.chatType,
    peerId: message.senderId,
    codexThreadRef: "thread-1",
    skillContextKey: null,
    status: BridgeSessionStatus.NeedsRebind,
    lastInboundAt: null,
    lastOutboundAt: null,
    lastError: "old error"
  };
}

describe("deliverDrafts", () => {
  it("delivers drafts in order", async () => {
    const calls: string[] = [];
    const egress: QqEgressPort = {
      deliver: vi.fn(async (draft: OutboundDraft) => {
        calls.push(draft.draftId);
        return {
          jobId: `job-${draft.draftId}`,
          sessionKey: draft.sessionKey,
          providerMessageId: null,
          deliveredAt: draft.createdAt
        };
      })
    };

    const drafts: OutboundDraft[] = [
      {
        draftId: "draft-1",
        sessionKey: "qqbot:default::qq:c2c:abc-123",
        text: "first",
        createdAt: "2026-04-08T10:00:01.000Z"
      },
      {
        draftId: "draft-2",
        sessionKey: "qqbot:default::qq:c2c:abc-123",
        text: "second",
        createdAt: "2026-04-08T10:00:02.000Z"
      }
    ];

    await deliverDrafts(egress, drafts);

    expect(calls).toEqual(["draft-1", "draft-2"]);
  });
});

describe("BridgeOrchestrator", () => {
  it("returns early when the inbound message was already seen", async () => {
    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(true),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };
    const sessionStore: SessionStorePort = {
      getSession: vi.fn(),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateSkillContextKey: vi.fn(),
      withSessionLock: vi.fn()
    };
    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn()
    };
    const qqEgress: QqEgressPort = {
      deliver: vi.fn()
    };

    const orchestrator = new BridgeOrchestrator({
      transcriptStore,
      sessionStore,
      conversationProvider,
      qqEgress
    });

    await orchestrator.handleInbound(createMessage());

    expect(transcriptStore.hasInbound).toHaveBeenCalledWith("msg-1");
    expect(sessionStore.withSessionLock).not.toHaveBeenCalled();
    expect(transcriptStore.recordInbound).not.toHaveBeenCalled();
    expect(conversationProvider.runTurn).not.toHaveBeenCalled();
    expect(qqEgress.deliver).not.toHaveBeenCalled();
  });

  it("suppresses duplicate inbound messages with different ids when the content repeats shortly after", async () => {
    const firstMessage = createMessage({
      messageId: "msg-1",
      text: "重复消息",
      receivedAt: "2026-04-10T21:58:49.000Z"
    });
    const secondMessage = createMessage({
      messageId: "msg-2",
      text: "重复消息",
      receivedAt: "2026-04-10T21:59:10.000Z"
    });

    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };
    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(null),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateSkillContextKey: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };
    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn().mockResolvedValue([])
    };
    const qqEgress: QqEgressPort = {
      deliver: vi.fn()
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const orchestrator = new BridgeOrchestrator({
      transcriptStore,
      sessionStore,
      conversationProvider,
      qqEgress
    });

    await orchestrator.handleInbound(firstMessage);
    await orchestrator.handleInbound(secondMessage);

    expect(transcriptStore.recordInbound).toHaveBeenCalledTimes(1);
    expect(transcriptStore.recordInbound).toHaveBeenCalledWith(firstMessage);
    expect(conversationProvider.runTurn).toHaveBeenCalledTimes(1);
    expect(conversationProvider.runTurn).toHaveBeenCalledWith(
      firstMessage,
      expect.objectContaining({
        onDraft: expect.any(Function)
      })
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "[qq-codex-bridge] duplicate inbound suppressed",
      expect.objectContaining({
        messageId: secondMessage.messageId,
        sessionKey: secondMessage.sessionKey
      })
    );
    warnSpy.mockRestore();
  });

  it("creates a missing session, processes the turn, and activates the session after success", async () => {
    const message = createMessage();
    const drafts: OutboundDraft[] = [
      {
        draftId: "draft-1",
        sessionKey: message.sessionKey,
        text: "reply-1",
        createdAt: "2026-04-08T10:00:01.000Z"
      },
      {
        draftId: "draft-2",
        sessionKey: message.sessionKey,
        text: "reply-2",
        createdAt: "2026-04-08T10:00:02.000Z"
      }
    ];

    const events: string[] = [];
    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(async () => {
        events.push("recordInbound");
      }),
      recordOutbound: vi.fn(async (draft: OutboundDraft) => {
        events.push(`recordOutbound:${draft.draftId}`);
      }),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };

    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(null),
      createSession: vi.fn(async () => {
        events.push("createSession");
      }),
      updateSessionStatus: vi.fn(async (_sessionKey, status, lastError) => {
        events.push(`updateSessionStatus:${status}:${lastError ?? "null"}`);
      }),
      updateBinding: vi.fn(),
      updateSkillContextKey: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => {
        events.push("withSessionLock");
        return work();
      })
    };

    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn(async () => {
        events.push("runTurn");
        return drafts;
      })
    };

    const qqEgress: QqEgressPort = {
      deliver: vi.fn(async (draft: OutboundDraft) => {
        events.push(`deliver:${draft.draftId}`);
        return {
          jobId: `job-${draft.draftId}`,
          sessionKey: draft.sessionKey,
          providerMessageId: null,
          deliveredAt: draft.createdAt
        };
      })
    };

    const orchestrator = new BridgeOrchestrator({
      transcriptStore,
      sessionStore,
      conversationProvider,
      qqEgress
    });

    await orchestrator.handleInbound(message);

    expect(sessionStore.createSession).toHaveBeenCalledWith({
      sessionKey: message.sessionKey,
      accountKey: message.accountKey,
      peerKey: message.peerKey,
      chatType: message.chatType,
      peerId: message.senderId,
      codexThreadRef: null,
      skillContextKey: null,
      status: BridgeSessionStatus.Active,
      lastInboundAt: message.receivedAt,
      lastOutboundAt: null,
      lastError: null
    });
    expect(transcriptStore.recordInbound).toHaveBeenCalledWith(message);
    expect(conversationProvider.runTurn).toHaveBeenCalledWith(
      message,
      expect.objectContaining({
        onDraft: expect.any(Function)
      })
    );
    expect(transcriptStore.recordOutbound).toHaveBeenNthCalledWith(1, drafts[0]);
    expect(transcriptStore.recordOutbound).toHaveBeenNthCalledWith(2, drafts[1]);
    expect(qqEgress.deliver).toHaveBeenNthCalledWith(1, drafts[0]);
    expect(qqEgress.deliver).toHaveBeenNthCalledWith(2, drafts[1]);
    expect(sessionStore.updateSessionStatus).toHaveBeenLastCalledWith(
      message.sessionKey,
      BridgeSessionStatus.Active,
      null
    );
    expect(events).toEqual([
      "withSessionLock",
      "createSession",
      "recordInbound",
      "runTurn",
      "recordOutbound:draft-1",
      "deliver:draft-1",
      "recordOutbound:draft-2",
      "deliver:draft-2",
      "updateSessionStatus:active:null"
    ]);
  });

  it("marks the session as needing rebind when turn execution fails", async () => {
    const message = createMessage();
    const error = new Error("turn failed");

    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };

    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(null),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateSkillContextKey: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };

    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn().mockRejectedValue(error)
    };

    const qqEgress: QqEgressPort = {
      deliver: vi.fn()
    };

    const orchestrator = new BridgeOrchestrator({
      transcriptStore,
      sessionStore,
      conversationProvider,
      qqEgress
    });

    await expect(orchestrator.handleInbound(message)).rejects.toThrow("turn failed");
    expect(sessionStore.updateSessionStatus).toHaveBeenCalledWith(
      message.sessionKey,
      BridgeSessionStatus.NeedsRebind,
      "turn failed"
    );
    expect(qqEgress.deliver).not.toHaveBeenCalled();
  });

  it("continues later drafts when one delivery fails", async () => {
    const message = createMessage();
    const drafts: OutboundDraft[] = [
      {
        draftId: "draft-1",
        sessionKey: message.sessionKey,
        text: "reply-1",
        createdAt: "2026-04-08T10:00:01.000Z"
      },
      {
        draftId: "draft-2",
        sessionKey: message.sessionKey,
        text: "reply-2",
        createdAt: "2026-04-08T10:00:02.000Z"
      }
    ];
    const error = new Error("delivery failed");

    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };

    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(null),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateSkillContextKey: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };

    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn().mockResolvedValue(drafts)
    };

    const qqEgress: QqEgressPort = {
      deliver: vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({
          jobId: "job-2",
          sessionKey: message.sessionKey,
          providerMessageId: null,
          deliveredAt: drafts[1].createdAt
        })
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const orchestrator = new BridgeOrchestrator({
      transcriptStore,
      sessionStore,
      conversationProvider,
      qqEgress
    });

    await expect(orchestrator.handleInbound(message)).resolves.toBeUndefined();
    expect(transcriptStore.recordOutbound).toHaveBeenCalledWith(drafts[0]);
    expect(transcriptStore.recordOutbound).toHaveBeenCalledWith(drafts[1]);
    expect(qqEgress.deliver).toHaveBeenNthCalledWith(1, drafts[0]);
    expect(qqEgress.deliver).toHaveBeenNthCalledWith(2, drafts[1]);
    expect(sessionStore.updateSessionStatus).toHaveBeenCalledWith(
      message.sessionKey,
      BridgeSessionStatus.Active,
      "draft-1: delivery failed"
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "[qq-codex-bridge] draft delivery failed",
      expect.objectContaining({
        sessionKey: message.sessionKey,
        messageId: message.messageId,
        draftId: "draft-1",
        error: "delivery failed"
      })
    );
    warnSpy.mockRestore();
  });

  it("keeps the session active when codex reply polling times out", async () => {
    const message = createMessage();

    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };

    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(null),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateSkillContextKey: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };

    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn().mockRejectedValue(
        new DesktopDriverError("Codex desktop reply did not arrive before timeout", "reply_timeout")
      )
    };

    const qqEgress: QqEgressPort = {
      deliver: vi.fn()
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const orchestrator = new BridgeOrchestrator({
      transcriptStore,
      sessionStore,
      conversationProvider,
      qqEgress
    });

    await expect(orchestrator.handleInbound(message)).resolves.toBeUndefined();
    expect(sessionStore.updateSessionStatus).toHaveBeenCalledWith(
      message.sessionKey,
      BridgeSessionStatus.Active,
      "Codex desktop reply did not arrive before timeout"
    );
    expect(qqEgress.deliver).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "[qq-codex-bridge] recoverable turn error",
      expect.objectContaining({
        messageId: message.messageId,
        sessionKey: message.sessionKey,
        error: "Codex desktop reply did not arrive before timeout"
      })
    );
  });

  it("delivers incremental drafts as they arrive and does not resend them after runTurn completes", async () => {
    const message = createMessage();
    const firstDraft: OutboundDraft = {
      draftId: "draft-partial-1",
      sessionKey: message.sessionKey,
      text: "先回一句",
      createdAt: "2026-04-10T10:00:01.000Z"
    };
    const secondDraft: OutboundDraft = {
      draftId: "draft-partial-2",
      sessionKey: message.sessionKey,
      text: "补充第二段",
      createdAt: "2026-04-10T10:00:03.000Z"
    };

    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };

    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(createSession(message)),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateSkillContextKey: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };

    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn(async (_message, options) => {
        await options?.onDraft?.(firstDraft);
        await options?.onDraft?.(secondDraft);
        return [];
      })
    };

    const qqEgress: QqEgressPort = {
      deliver: vi.fn(async (draft: OutboundDraft) => ({
        jobId: `job-${draft.draftId}`,
        sessionKey: draft.sessionKey,
        providerMessageId: null,
        deliveredAt: draft.createdAt
      }))
    };

    const orchestrator = new BridgeOrchestrator({
      transcriptStore,
      sessionStore,
      conversationProvider,
      qqEgress
    });

    await orchestrator.handleInbound(message);

    expect(transcriptStore.recordOutbound).toHaveBeenNthCalledWith(1, firstDraft);
    expect(transcriptStore.recordOutbound).toHaveBeenNthCalledWith(2, secondDraft);
    expect(qqEgress.deliver).toHaveBeenNthCalledWith(1, firstDraft);
    expect(qqEgress.deliver).toHaveBeenNthCalledWith(2, secondDraft);
    expect(qqEgress.deliver).toHaveBeenCalledTimes(2);
    expect(conversationProvider.runTurn).toHaveBeenCalledWith(
      message,
      expect.objectContaining({
        onDraft: expect.any(Function)
      })
    );
  });
});
