import { describe, expect, it, vi } from "vitest";
import { BridgeSessionStatus } from "../../packages/domain/src/session.js";
import { DesktopDriverError } from "../../packages/domain/src/driver.js";
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
      lastCodexTurnId: null,
      skillContextKey: null,
      status: BridgeSessionStatus.Active,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastError: null
    }),
    createSession: vi.fn().mockResolvedValue(undefined),
    updateSessionStatus: vi.fn().mockResolvedValue(undefined),
    updateBinding: vi.fn().mockResolvedValue(undefined),
    updateLastCodexTurnId: vi.fn().mockResolvedValue(undefined),
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

function createDriver(
  overrides: Partial<
    DesktopDriverPort & {
      getQuotaSummary: () => Promise<string | null>;
    }
  > = {}
): DesktopDriverPort & {
  getQuotaSummary: () => Promise<string | null>;
} {
  return {
    ensureAppReady: vi.fn().mockResolvedValue(undefined),
    getControlState: vi.fn().mockResolvedValue({
      model: "GPT-5.4",
      reasoningEffort: "高",
      workspace: "本地",
      branch: "codex/qq-codex-bridge",
      permissionMode: "完全访问权限",
      quotaSummary: null
    }),
    switchModel: vi.fn().mockResolvedValue({
      model: "GPT-5.4",
      reasoningEffort: "高",
      workspace: "本地",
      branch: "codex/qq-codex-bridge",
      permissionMode: "完全访问权限",
      quotaSummary: null
    }),
    getQuotaSummary: vi
      .fn()
      .mockResolvedValue("5 小时 22%（01:56 重置）\n1 周 25%（4月17日 重置）"),
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
    }),
    ...overrides
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
        text: expect.stringContaining("| 序号 | 项目 | 线程标题 | 最近活动 |")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("| 👉🏻 1 | skills | 线程 A | 2 小时 |")
      })
    );
  });

  it("marks the bound app-server thread in /threads even when it is not the desktop current thread", async () => {
    const sessionStore = createSessionStore();
    vi.mocked(sessionStore.getSession).mockResolvedValue({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      accountKey: "qqbot:default",
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      peerId: "OPENID123",
      codexThreadRef: "codex-app-thread:thread-b:old-title",
      lastCodexTurnId: null,
      skillContextKey: null,
      status: BridgeSessionStatus.Active,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastError: null
    });
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver({
      listRecentThreads: vi.fn().mockResolvedValue([
        {
          index: 1,
          title: "线程 A",
          projectName: "skills",
          relativeTime: "2 小时",
          isCurrent: false,
          threadRef: "codex-app-thread:thread-a:new-title"
        },
        {
          index: 2,
          title: "线程 B",
          projectName: "Desktop",
          relativeTime: "1 天",
          isCurrent: false,
          threadRef: "codex-app-thread:thread-b:new-title"
        }
      ])
    });
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/t"))).resolves.toBe(true);

    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("| 👉🏻 2 | Desktop | 线程 B | 1 天 |")
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
    expect(sessionStore.updateSkillContextKey).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      null
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("绑定标识：codex-thread:page-1:bbb")
      })
    );
  });

  it("returns a friendly reply when switching to a sidebar thread fails", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver({
      switchToThread: vi.fn().mockRejectedValue(
        new DesktopDriverError("Codex desktop thread switch failed: thread_not_found", "session_not_found")
      )
    });
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/thread use 2"))).resolves.toBe(true);
    expect(sessionStore.updateBinding).not.toHaveBeenCalled();
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("切换失败：没有在当前 Codex 侧边栏里找到这个线程。")
      })
    );
  });

  it("supports shorthand thread commands", async () => {
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

    await expect(handler.handleIfCommand(createPrivateMessage("/t"))).resolves.toBe(true);
    await expect(handler.handleIfCommand(createPrivateMessage("/tc"))).resolves.toBe(true);
    await expect(handler.handleIfCommand(createPrivateMessage("/tu 2"))).resolves.toBe(true);
    await expect(handler.handleIfCommand(createPrivateMessage("/tn 快捷新线程"))).resolves.toBe(true);
    await expect(handler.handleIfCommand(createPrivateMessage("/tf 快捷分叉"))).resolves.toBe(true);

    expect(desktopDriver.listRecentThreads).toHaveBeenCalledWith(20);
    expect(desktopDriver.switchToThread).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      "codex-thread:page-1:bbb"
    );
    expect(desktopDriver.createThread).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      expect.stringContaining("线程标题：快捷新线程")
    );
    expect(desktopDriver.createThread).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      expect.stringContaining("线程标题：快捷分叉")
    );
  });

  it("shows help for /help", async () => {
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

    await expect(handler.handleIfCommand(createPrivateMessage("/help"))).resolves.toBe(true);

    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("| 查看最近活跃线程 | `/threads` | `/t` |")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("建议先发 `/t` 看列表，再用 `/tu 2` 这种方式切换。")
      })
    );
  });

  it("shows model status for /model and /m", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver({
      getControlState: vi.fn().mockResolvedValue({
        model: "GPT-5.4",
        reasoningEffort: "高",
        workspace: "本地",
        branch: "codex/qq-codex-bridge",
        permissionMode: "完全访问权限",
        quotaSummary: null
      })
    });
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/model"))).resolves.toBe(true);
    await expect(handler.handleIfCommand(createPrivateMessage("/m"))).resolves.toBe(true);

    expect(desktopDriver.getControlState).toHaveBeenCalledTimes(2);
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("当前模型：GPT-5.4")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("推理强度：高")
      })
    );
  });

  it("switches model for /model use and /mu", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver({
      switchModel: vi.fn().mockResolvedValue({
        model: "GPT-5.4-Mini",
        reasoningEffort: "高",
        workspace: "本地",
        branch: "codex/qq-codex-bridge",
        permissionMode: "完全访问权限",
        quotaSummary: null
      })
    });
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/model use GPT-5.4-Mini"))).resolves.toBe(true);
    await expect(handler.handleIfCommand(createPrivateMessage("/mu GPT-5.4-Mini"))).resolves.toBe(true);

    expect(desktopDriver.switchModel).toHaveBeenNthCalledWith(1, "GPT-5.4-Mini");
    expect(desktopDriver.switchModel).toHaveBeenNthCalledWith(2, "GPT-5.4-Mini");
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("已切换模型：GPT-5.4-Mini")
      })
    );
  });

  it("shows quota summary for /quota and /q", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver({
      getControlState: vi.fn().mockResolvedValue({
        model: "GPT-5.4",
        reasoningEffort: "高",
        workspace: "本地",
        branch: "codex/qq-codex-bridge",
        permissionMode: "完全访问权限",
        quotaSummary: null
      }),
      getQuotaSummary: vi.fn().mockResolvedValue("5 小时 22%（01:56 重置）\n1 周 25%（4月17日 重置）")
    });
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/quota"))).resolves.toBe(true);
    await expect(handler.handleIfCommand(createPrivateMessage("/q"))).resolves.toBe(true);

    expect(desktopDriver.getQuotaSummary).toHaveBeenCalledTimes(2);
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("额度信息：5 小时 22%（01:56 重置）")
      })
    );
  });

  it("shows control status for /status and /st", async () => {
    const sessionStore = createSessionStore();
    vi.mocked(sessionStore.getSession).mockResolvedValue({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      accountKey: "qqbot:default",
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      peerId: "OPENID123",
      codexThreadRef: "codex-app-thread:thread-b:stale-title",
      lastCodexTurnId: null,
      skillContextKey: null,
      status: BridgeSessionStatus.Active,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastError: null
    });
    const transcriptStore = createTranscriptStore();
    const getControlState = vi.fn().mockResolvedValue({
      threadRef: "codex-app-thread:thread-b:fresh-title",
      threadTitle: "线程 B",
      threadProjectName: "qq-codex-bridge",
      threadRelativeTime: "刚刚",
      model: "GPT-5.4",
      reasoningEffort: "高",
      workspace: "qq-codex-bridge",
      branch: "codex/weixin-multi-channel",
      permissionMode: "完全访问权限",
      quotaSummary: null
    });
    const desktopDriver = createDriver({
      getControlState,
      getQuotaSummary: vi.fn().mockResolvedValue("5 小时 22%（01:56 重置）\n1 周 25%（4月17日 重置）")
    });
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/status"))).resolves.toBe(true);
    await expect(handler.handleIfCommand(createPrivateMessage("/st"))).resolves.toBe(true);

    expect(getControlState).toHaveBeenCalledWith({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "codex-app-thread:thread-b:stale-title"
    });
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("线程绑定：codex-app-thread:thread-b:fresh-title")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("线程标题：线程 B")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("工作区：qq-codex-bridge")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("分支：codex/weixin-multi-channel")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("额度：5 小时 22%（01:56 重置）")
      })
    );
  });

  it("shows help for /h", async () => {
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

    await expect(handler.handleIfCommand(createPrivateMessage("/h"))).resolves.toBe(true);

    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("| 查看当前模型 | `/model` | `/m` |")
      })
    );
  });

  it("intercepts unknown slash commands and returns bridge guidance", async () => {
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

    await expect(handler.handleIfCommand(createPrivateMessage("/quotaa"))).resolves.toBe(true);

    expect(desktopDriver.getControlState).not.toHaveBeenCalled();
    expect(desktopDriver.listRecentThreads).not.toHaveBeenCalled();
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("未识别的桥接快捷指令：`/quotaa`")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("这条 `/` 指令不会转发给 Codex。")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("| 查看额度信息 | `/quota` | `/q` |")
      })
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
