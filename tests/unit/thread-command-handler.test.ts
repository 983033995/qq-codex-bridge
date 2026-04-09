import { describe, expect, it, vi } from "vitest";
import { BridgeSessionStatus } from "../../packages/domain/src/session.js";
import type { InboundMessage } from "../../packages/domain/src/message.js";
import type { DesktopDriverPort } from "../../packages/ports/src/conversation.js";
import type { QqEgressPort } from "../../packages/ports/src/qq.js";
import type { SessionStorePort, TranscriptStorePort } from "../../packages/ports/src/store.js";
import { ThreadCommandHandler } from "../../apps/bridge-daemon/src/thread-command-handler.js";

function createPrivateMessage(text: string): InboundMessage {
  return {
    messageId: "msg-1",
    accountKey: "qqbot:default",
    sessionKey: "qqbot:default::qq:c2c:OPENID123",
    peerKey: "qq:c2c:OPENID123",
    chatType: "c2c",
    senderId: "OPENID123",
    text,
    receivedAt: "2026-04-09T16:00:00.000Z"
  };
}

function createSessionStore(): SessionStorePort {
  return {
    getSession: vi.fn().mockResolvedValue({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      accountKey: "qqbot:default",
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      peerId: "OPENID123",
      codexThreadRef: null,
      skillContextKey: null,
      status: BridgeSessionStatus.Active,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastError: null
    }),
    createSession: vi.fn().mockResolvedValue(undefined),
    updateSessionStatus: vi.fn().mockResolvedValue(undefined),
    updateBinding: vi.fn().mockResolvedValue(undefined),
    updateSkillContextKey: vi.fn().mockResolvedValue(undefined),
    withSessionLock: vi.fn(async (_sessionKey, work) => work())
  };
}

function createTranscriptStore(): TranscriptStorePort {
  return {
    recordInbound: vi.fn().mockResolvedValue(undefined),
    recordOutbound: vi.fn().mockResolvedValue(undefined),
    hasInbound: vi.fn().mockResolvedValue(false),
    listRecentConversation: vi.fn().mockResolvedValue([
      {
        direction: "inbound",
        text: "用户问题 1",
        createdAt: "2026-04-09T15:58:00.000Z"
      },
      {
        direction: "outbound",
        text: "助手回答 1",
        createdAt: "2026-04-09T15:58:10.000Z"
      }
    ])
  };
}

function createDriver(): DesktopDriverPort {
  return {
    ensureAppReady: vi.fn().mockResolvedValue(undefined),
    openOrBindSession: vi.fn(),
    sendUserMessage: vi.fn(),
    collectAssistantReply: vi.fn(),
    markSessionBroken: vi.fn(),
    listRecentThreads: vi.fn().mockResolvedValue([
      {
        index: 1,
        title: "线程 A",
        projectName: "skills",
        relativeTime: "2 小时",
        isCurrent: true,
        threadRef: "codex-thread:page-1:aaa"
      },
      {
        index: 2,
        title: "线程 B",
        projectName: "Desktop",
        relativeTime: "1 天",
        isCurrent: false,
        threadRef: "codex-thread:page-1:bbb"
      }
    ]),
    switchToThread: vi.fn().mockResolvedValue({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "codex-thread:page-1:bbb"
    }),
    createThread: vi.fn().mockResolvedValue({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "codex-thread:page-1:new"
    })
  } as unknown as DesktopDriverPort;
}

function createEgress(): QqEgressPort {
  return {
    deliver: vi.fn().mockResolvedValue({
      jobId: "job-1",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      providerMessageId: null,
      deliveredAt: "2026-04-09T16:00:00.000Z"
    })
  };
}

describe("thread command handler", () => {
  it("lists recent threads for /threads in private chat", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver();
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/threads"))).resolves.toBe(true);
    expect(desktopDriver.listRecentThreads).toHaveBeenCalledWith(20);
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        replyToMessageId: "msg-1",
        text: expect.stringContaining("1. [当前] skills / 线程 A")
      })
    );
  });

  it("switches binding for /thread use <index>", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver();
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/thread use 2"))).resolves.toBe(true);
    expect(desktopDriver.switchToThread).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      "codex-thread:page-1:bbb"
    );
    expect(sessionStore.updateBinding).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      "codex-thread:page-1:bbb"
    );
  });

  it("creates a forked thread with recent qq conversation summary", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver();
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/thread fork 新专题"))).resolves.toBe(true);
    expect(transcriptStore.listRecentConversation).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      8
    );
    expect(desktopDriver.createThread).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      expect.stringContaining("新专题")
    );
    expect(desktopDriver.createThread).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      expect.stringContaining("用户：用户问题 1")
    );
  });
});
