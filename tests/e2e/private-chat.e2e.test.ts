import { describe, expect, it, vi } from "vitest";
import { MediaArtifactKind } from "../../packages/domain/src/message.js";
import { bootstrap } from "../../apps/bridge-daemon/src/bootstrap.js";
import { createIngressMessageHandler } from "../../apps/bridge-daemon/src/main.js";
import { ThreadCommandHandler } from "../../apps/bridge-daemon/src/thread-command-handler.js";

describe("bootstrap integration", () => {
  it("builds the app container with orchestrator and adapters", () => {
    process.env.QQBOT_APP_ID = "app-id";
    process.env.QQBOT_CLIENT_SECRET = "secret";
    process.env.QQ_CODEX_DATABASE_PATH = ":memory:";
    process.env.CODEX_REMOTE_DEBUGGING_PORT = "9229";

    const app = bootstrap();
    try {
      expect(app.orchestrator).toBeDefined();
      expect(app.adapters.qq).toBeDefined();
      expect(app.adapters.codexDesktop).toBeDefined();
    } finally {
      app.db.close();
    }
  });

  it("upgrades a page-level codex binding to the current stable thread after a successful turn", async () => {
    process.env.QQBOT_APP_ID = "app-id";
    process.env.QQBOT_CLIENT_SECRET = "secret";
    process.env.QQ_CODEX_DATABASE_PATH = ":memory:";
    process.env.CODEX_REMOTE_DEBUGGING_PORT = "9229";

    const app = bootstrap();
    try {
      vi.spyOn(app.adapters.codexDesktop, "ensureAppReady").mockResolvedValue(undefined);
      const openOrBindSession = vi
        .spyOn(app.adapters.codexDesktop, "openOrBindSession")
        .mockResolvedValue({
          sessionKey: "qqbot:default::qq:c2c:abc-123",
          codexThreadRef: "cdp-target:page-1"
        });
      vi.spyOn(app.adapters.codexDesktop, "listRecentThreads").mockResolvedValue([
        {
          index: 1,
          title: "线程 A",
          projectName: null,
          relativeTime: "刚刚",
          isCurrent: true,
          threadRef: "codex-thread:page-1:thread-a"
        }
      ]);
      vi.spyOn(app.adapters.codexDesktop, "sendUserMessage").mockResolvedValue(undefined);
      vi.spyOn(app.adapters.codexDesktop, "collectAssistantReply")
        .mockResolvedValueOnce([
          {
            draftId: "draft-1",
            turnId: "turn-1",
            sessionKey: "qqbot:default::qq:c2c:abc-123",
            text: "reply-1",
            createdAt: "2026-04-09T11:05:00.000Z"
          }
        ])
        .mockResolvedValueOnce([
          {
            draftId: "draft-2",
            turnId: "turn-2",
            sessionKey: "qqbot:default::qq:c2c:abc-123",
            text: "reply-2",
            createdAt: "2026-04-09T11:05:01.000Z"
          }
        ]);
      vi.spyOn(app.adapters.qq.egress, "deliver").mockResolvedValue({
        jobId: "job-1",
        sessionKey: "qqbot:default::qq:c2c:abc-123",
        providerMessageId: null,
        deliveredAt: "2026-04-09T11:05:00.000Z"
      });

      await app.orchestrator.handleInbound({
        messageId: "msg-1",
        accountKey: "qqbot:default",
        sessionKey: "qqbot:default::qq:c2c:abc-123",
        peerKey: "qq:c2c:abc-123",
        chatType: "c2c",
        senderId: "abc-123",
        text: "hello",
        receivedAt: "2026-04-09T11:05:00.000Z"
      });

      await app.orchestrator.handleInbound({
        messageId: "msg-2",
        accountKey: "qqbot:default",
        sessionKey: "qqbot:default::qq:c2c:abc-123",
        peerKey: "qq:c2c:abc-123",
        chatType: "c2c",
        senderId: "abc-123",
        text: "hello again",
        receivedAt: "2026-04-09T11:05:01.000Z"
      });

      expect(openOrBindSession).toHaveBeenNthCalledWith(
        1,
        "qqbot:default::qq:c2c:abc-123",
        {
          sessionKey: "qqbot:default::qq:c2c:abc-123",
          codexThreadRef: null
        }
      );
      expect(openOrBindSession).toHaveBeenNthCalledWith(
        2,
        "qqbot:default::qq:c2c:abc-123",
        {
          sessionKey: "qqbot:default::qq:c2c:abc-123",
          codexThreadRef: "codex-thread:page-1:thread-a"
        }
      );

      const stored = app.db
        .prepare(
          `SELECT codex_thread_ref AS codexThreadRef,
                  last_codex_turn_id AS lastCodexTurnId
           FROM bridge_sessions
           WHERE session_key = ?`
        )
        .get("qqbot:default::qq:c2c:abc-123") as
          | { codexThreadRef: string | null; lastCodexTurnId: string | null }
          | undefined;

      expect(stored?.codexThreadRef).toBe("codex-thread:page-1:thread-a");
      expect(stored?.lastCodexTurnId).toBe("turn-2");
    } finally {
      app.db.close();
    }
  });

  it("does not persist a new binding when the first message send fails", async () => {
    process.env.QQBOT_APP_ID = "app-id";
    process.env.QQBOT_CLIENT_SECRET = "secret";
    process.env.QQ_CODEX_DATABASE_PATH = ":memory:";
    process.env.CODEX_REMOTE_DEBUGGING_PORT = "9229";

    const app = bootstrap();
    try {
      vi.spyOn(app.adapters.codexDesktop, "ensureAppReady").mockResolvedValue(undefined);
      vi.spyOn(app.adapters.codexDesktop, "openOrBindSession").mockResolvedValue({
        sessionKey: "qqbot:default::qq:c2c:broken",
        codexThreadRef: "cdp-target:page-bad"
      });
      vi.spyOn(app.adapters.codexDesktop, "sendUserMessage").mockRejectedValue(
        new Error("input not found")
      );

      await expect(
        app.orchestrator.handleInbound({
          messageId: "msg-bad-1",
          accountKey: "qqbot:default",
          sessionKey: "qqbot:default::qq:c2c:broken",
          peerKey: "qq:c2c:broken",
          chatType: "c2c",
          senderId: "broken",
          text: "hello",
          receivedAt: "2026-04-09T11:05:00.000Z"
        })
      ).rejects.toThrow("input not found");

      const stored = app.db
        .prepare(
          `SELECT codex_thread_ref AS codexThreadRef
           FROM bridge_sessions
           WHERE session_key = ?`
        )
        .get("qqbot:default::qq:c2c:broken") as { codexThreadRef: string | null } | undefined;

      expect(stored?.codexThreadRef).toBeNull();
    } finally {
      app.db.close();
    }
  });

  it("uses the newly selected thread binding for the next qq message after /tu", async () => {
    process.env.QQBOT_APP_ID = "app-id";
    process.env.QQBOT_CLIENT_SECRET = "secret";
    process.env.QQ_CODEX_DATABASE_PATH = ":memory:";
    process.env.CODEX_REMOTE_DEBUGGING_PORT = "9229";

    const app = bootstrap();
    try {
      const threadCommandHandler = new ThreadCommandHandler({
        sessionStore: app.sessionStore,
        transcriptStore: app.transcriptStore,
        desktopDriver: app.adapters.codexDesktop,
        qqEgress: app.adapters.qq.egress
      });
      const ingressHandler = createIngressMessageHandler({
        threadCommandHandler,
        orchestrator: app.orchestrator
      });

      vi.spyOn(app.adapters.codexDesktop, "ensureAppReady").mockResolvedValue(undefined);
      vi.spyOn(app.adapters.codexDesktop, "listRecentThreads").mockResolvedValue([
        {
          index: 1,
          title: "线程 A",
          projectName: "demo",
          relativeTime: "刚刚",
          isCurrent: false,
          threadRef: "codex-app-thread:thread-a:aaa"
        },
        {
          index: 2,
          title: "线程 B",
          projectName: "demo",
          relativeTime: "1 分钟",
          isCurrent: false,
          threadRef: "codex-app-thread:thread-b:bbb"
        }
      ]);
      vi.spyOn(app.adapters.codexDesktop, "switchToThread").mockResolvedValue({
        sessionKey: "qqbot:default::qq:c2c:switch-user",
        codexThreadRef: "codex-app-thread:thread-b:bbb"
      });
      const openOrBindSession = vi
        .spyOn(app.adapters.codexDesktop, "openOrBindSession")
        .mockImplementation(async (sessionKey, binding) => ({
          sessionKey,
          codexThreadRef: binding?.codexThreadRef ?? "codex-app-thread:thread-a:aaa"
        }));
      const sendUserMessage = vi
        .spyOn(app.adapters.codexDesktop, "sendUserMessage")
        .mockResolvedValue(undefined);
      vi.spyOn(app.adapters.codexDesktop, "collectAssistantReply").mockResolvedValue([
        {
          draftId: "draft-after-switch",
          turnId: "turn-after-switch",
          sessionKey: "qqbot:default::qq:c2c:switch-user",
          text: "reply-after-switch",
          createdAt: "2026-04-22T10:20:01.000Z"
        }
      ]);
      vi.spyOn(app.adapters.qq.egress, "deliver").mockResolvedValue({
        jobId: "job-after-switch",
        sessionKey: "qqbot:default::qq:c2c:switch-user",
        providerMessageId: null,
        deliveredAt: "2026-04-22T10:20:01.000Z"
      });

      await ingressHandler({
        messageId: "cmd-switch-thread-b",
        accountKey: "qqbot:default",
        sessionKey: "qqbot:default::qq:c2c:switch-user",
        peerKey: "qq:c2c:switch-user",
        chatType: "c2c",
        senderId: "switch-user",
        text: "/tu 2",
        receivedAt: "2026-04-22T10:20:00.000Z"
      });

      await ingressHandler({
        messageId: "msg-after-switch",
        accountKey: "qqbot:default",
        sessionKey: "qqbot:default::qq:c2c:switch-user",
        peerKey: "qq:c2c:switch-user",
        chatType: "c2c",
        senderId: "switch-user",
        text: "这条消息应该进入线程 B",
        receivedAt: "2026-04-22T10:20:01.000Z"
      });

      expect(openOrBindSession).toHaveBeenCalledWith(
        "qqbot:default::qq:c2c:switch-user",
        {
          sessionKey: "qqbot:default::qq:c2c:switch-user",
          codexThreadRef: "codex-app-thread:thread-b:bbb"
        }
      );
      expect(sendUserMessage).toHaveBeenCalledWith(
        {
          sessionKey: "qqbot:default::qq:c2c:switch-user",
          codexThreadRef: "codex-app-thread:thread-b:bbb"
        },
        expect.objectContaining({
          messageId: "msg-after-switch",
          text: expect.stringContaining("这条消息应该进入线程 B")
        })
      );

      const stored = app.db
        .prepare(
          `SELECT codex_thread_ref AS codexThreadRef,
                  skill_context_key AS skillContextKey,
                  last_codex_turn_id AS lastCodexTurnId
           FROM bridge_sessions
           WHERE session_key = ?`
        )
        .get("qqbot:default::qq:c2c:switch-user") as
          | {
              codexThreadRef: string | null;
              skillContextKey: string | null;
              lastCodexTurnId: string | null;
            }
          | undefined;

      expect(stored?.codexThreadRef).toBe("codex-app-thread:thread-b:bbb");
      expect(stored?.skillContextKey).toBe("codex-app-thread:thread-b:bbb:qqbot-skill-v2");
      expect(stored?.lastCodexTurnId).toBe("turn-after-switch");
    } finally {
      app.db.close();
    }
  });

  it("strips qqmedia marker text for weixin sessions while keeping media artifacts", async () => {
    process.env.QQBOT_APP_ID = "app-id";
    process.env.QQBOT_CLIENT_SECRET = "secret";
    process.env.QQ_CODEX_DATABASE_PATH = ":memory:";
    process.env.CODEX_REMOTE_DEBUGGING_PORT = "9229";
    process.env.WEIXIN_ENABLED = "true";
    process.env.WEIXIN_ACCOUNT_ID = "default";
    process.env.WEIXIN_WEBHOOK_PATH = "/webhooks/weixin";
    process.env.WEIXIN_EGRESS_BASE_URL = "http://127.0.0.1:3200";
    process.env.WEIXIN_EGRESS_TOKEN = "token";

    const app = bootstrap();
    try {
      vi.spyOn(app.adapters.codexDesktop, "ensureAppReady").mockResolvedValue(undefined);
      vi.spyOn(app.adapters.codexDesktop, "openOrBindSession").mockResolvedValue({
        sessionKey: "weixin:default::wx:c2c:wxid-1",
        codexThreadRef: "codex-app-thread:weixin-1"
      });
      vi.spyOn(app.adapters.codexDesktop, "sendUserMessage").mockResolvedValue(undefined);
      vi.spyOn(app.adapters.codexDesktop, "collectAssistantReply").mockResolvedValue([
        {
          draftId: "draft-media-1",
          sessionKey: "weixin:default::wx:c2c:wxid-1",
          text: "<qqmedia>/Volumes/13759427003/AI/qq-codex-bridge/runtime/demo.jpg</qqmedia>",
          mediaArtifacts: [
            {
              kind: MediaArtifactKind.Image,
              sourceUrl: "/Volumes/13759427003/AI/qq-codex-bridge/runtime/demo.jpg",
              localPath: "/Volumes/13759427003/AI/qq-codex-bridge/runtime/demo.jpg",
              mimeType: "image/jpeg",
              fileSize: 2048,
              originalName: "demo.jpg"
            }
          ],
          createdAt: "2026-04-15T03:20:00.000Z"
        }
      ]);

      if (!app.adapters.weixin) {
        throw new Error("expected weixin adapter to be initialized");
      }

      const deliverSpy = vi.spyOn(app.adapters.weixin.egress, "deliver").mockResolvedValue({
        jobId: "job-media-1",
        sessionKey: "weixin:default::wx:c2c:wxid-1",
        providerMessageId: "provider-1",
        deliveredAt: "2026-04-15T03:20:00.000Z"
      });

      await app.orchestrators.weixin?.handleInbound({
        messageId: "wx-msg-1",
        accountKey: "weixin:default",
        sessionKey: "weixin:default::wx:c2c:wxid-1",
        peerKey: "wx:c2c:wxid-1",
        chatType: "c2c",
        senderId: "wxid-1",
        text: "把图片发回来",
        receivedAt: "2026-04-15T03:19:59.000Z"
      });

      expect(deliverSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "",
          mediaArtifacts: [
            expect.objectContaining({
              localPath: "/Volumes/13759427003/AI/qq-codex-bridge/runtime/demo.jpg"
            })
          ]
        })
      );
    } finally {
      app.db.close();
      delete process.env.WEIXIN_ENABLED;
      delete process.env.WEIXIN_ACCOUNT_ID;
      delete process.env.WEIXIN_WEBHOOK_PATH;
      delete process.env.WEIXIN_EGRESS_BASE_URL;
      delete process.env.WEIXIN_EGRESS_TOKEN;
    }
  });

  it("skips trailing weixin qqmedia path fragments after the media draft was already emitted", async () => {
    process.env.QQBOT_APP_ID = "app-id";
    process.env.QQBOT_CLIENT_SECRET = "secret";
    process.env.QQ_CODEX_DATABASE_PATH = ":memory:";
    process.env.CODEX_REMOTE_DEBUGGING_PORT = "9229";
    process.env.WEIXIN_ENABLED = "true";
    process.env.WEIXIN_ACCOUNT_ID = "default";
    process.env.WEIXIN_WEBHOOK_PATH = "/webhooks/weixin";
    process.env.WEIXIN_EGRESS_BASE_URL = "http://127.0.0.1:3200";
    process.env.WEIXIN_EGRESS_TOKEN = "token";

    const app = bootstrap();
    try {
      vi.spyOn(app.adapters.codexDesktop, "ensureAppReady").mockResolvedValue(undefined);
      vi.spyOn(app.adapters.codexDesktop, "openOrBindSession").mockResolvedValue({
        sessionKey: "weixin:default::wx:c2c:wxid-2",
        codexThreadRef: "codex-app-thread:weixin-2"
      });
      vi.spyOn(app.adapters.codexDesktop, "sendUserMessage").mockResolvedValue(undefined);
      vi.spyOn(app.adapters.codexDesktop, "collectAssistantReply").mockResolvedValue([
        {
          draftId: "draft-media-head",
          sessionKey: "weixin:default::wx:c2c:wxid-2",
          text: "<qqmedia>/Volumes/137",
          mediaArtifacts: [
            {
              kind: MediaArtifactKind.Image,
              sourceUrl: "/Volumes/13759427003/AI/qq-codex-bridge/runtime/demo.jpg",
              localPath: "/Volumes/13759427003/AI/qq-codex-bridge/runtime/demo.jpg",
              mimeType: "image/jpeg",
              fileSize: 2048,
              originalName: "demo.jpg"
            }
          ],
          createdAt: "2026-04-15T03:21:00.000Z"
        },
        {
          draftId: "draft-media-tail",
          sessionKey: "weixin:default::wx:c2c:wxid-2",
          text: "59427003/AI/qq-codex-bridge/runtime/demo.jpg</qqmedia>",
          createdAt: "2026-04-15T03:21:01.000Z"
        }
      ]);

      if (!app.adapters.weixin) {
        throw new Error("expected weixin adapter to be initialized");
      }

      const deliverSpy = vi.spyOn(app.adapters.weixin.egress, "deliver").mockResolvedValue({
        jobId: "job-media-tail",
        sessionKey: "weixin:default::wx:c2c:wxid-2",
        providerMessageId: "provider-tail",
        deliveredAt: "2026-04-15T03:21:00.000Z"
      });

      await app.orchestrators.weixin?.handleInbound({
        messageId: "wx-msg-2",
        accountKey: "weixin:default",
        sessionKey: "weixin:default::wx:c2c:wxid-2",
        peerKey: "wx:c2c:wxid-2",
        chatType: "c2c",
        senderId: "wxid-2",
        text: "把图片发回来",
        receivedAt: "2026-04-15T03:20:59.000Z"
      });

      expect(deliverSpy).toHaveBeenCalledTimes(1);
      expect(deliverSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "",
          mediaArtifacts: [
            expect.objectContaining({
              localPath: "/Volumes/13759427003/AI/qq-codex-bridge/runtime/demo.jpg"
            })
          ]
        })
      );
    } finally {
      app.db.close();
      delete process.env.WEIXIN_ENABLED;
      delete process.env.WEIXIN_ACCOUNT_ID;
      delete process.env.WEIXIN_WEBHOOK_PATH;
      delete process.env.WEIXIN_EGRESS_BASE_URL;
      delete process.env.WEIXIN_EGRESS_TOKEN;
    }
  });

  it("allows concurrent turns across sessions when using the app-server transport", async () => {
    process.env.QQBOT_APP_ID = "app-id";
    process.env.QQBOT_CLIENT_SECRET = "secret";
    process.env.QQ_CODEX_DATABASE_PATH = ":memory:";
    process.env.CODEX_REMOTE_DEBUGGING_PORT = "9229";

    const app = bootstrap();
    try {
      vi.spyOn(app.adapters.codexDesktop, "ensureAppReady").mockResolvedValue(undefined);
      vi.spyOn(app.adapters.codexDesktop, "openOrBindSession").mockImplementation(async (sessionKey) => ({
        sessionKey,
        codexThreadRef: `codex-app-thread:${sessionKey}`
      }));

      let activeTurns = 0;
      let maxConcurrentTurns = 0;
      const releaseQueue: Array<() => void> = [];

      vi.spyOn(app.adapters.codexDesktop, "sendUserMessage").mockImplementation(async () => {
        activeTurns += 1;
        maxConcurrentTurns = Math.max(maxConcurrentTurns, activeTurns);
        await new Promise<void>((resolve) => {
          releaseQueue.push(resolve);
        });
        activeTurns -= 1;
      });

      vi.spyOn(app.adapters.codexDesktop, "collectAssistantReply").mockResolvedValue([]);
      vi.spyOn(app.adapters.qq.egress, "deliver").mockResolvedValue({
        jobId: "job-app-server-concurrent",
        sessionKey: "qqbot:default::qq:c2c:session-a",
        providerMessageId: null,
        deliveredAt: "2026-04-21T14:00:00.000Z"
      });

      const turnA = app.orchestrator.handleInbound({
        messageId: "msg-app-server-a",
        accountKey: "qqbot:default",
        sessionKey: "qqbot:default::qq:c2c:session-a",
        peerKey: "qq:c2c:session-a",
        chatType: "c2c",
        senderId: "session-a",
        text: "第一条 app-server 并发消息",
        receivedAt: "2026-04-21T14:00:00.000Z"
      });

      const turnB = app.orchestrator.handleInbound({
        messageId: "msg-app-server-b",
        accountKey: "qqbot:default",
        sessionKey: "qqbot:default::qq:c2c:session-b",
        peerKey: "qq:c2c:session-b",
        chatType: "c2c",
        senderId: "session-b",
        text: "第二条 app-server 并发消息",
        receivedAt: "2026-04-21T14:00:00.500Z"
      });

      for (let attempt = 0; attempt < 50 && releaseQueue.length < 2; attempt += 1) {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(releaseQueue.length).toBe(2);
      expect(maxConcurrentTurns).toBe(2);

      releaseQueue.shift()?.();
      releaseQueue.shift()?.();
      await Promise.all([turnA, turnB]);
    } finally {
      app.db.close();
    }
  });

  it("serializes turns across different sessions so a single Codex desktop is never driven concurrently", async () => {
    process.env.QQBOT_APP_ID = "app-id";
    process.env.QQBOT_CLIENT_SECRET = "secret";
    process.env.QQ_CODEX_DATABASE_PATH = ":memory:";
    process.env.CODEX_REMOTE_DEBUGGING_PORT = "9229";
    process.env.CODEX_DESKTOP_TRANSPORT = "dom";

    const app = bootstrap();
    try {
      vi.spyOn(app.adapters.codexDesktop, "ensureAppReady").mockResolvedValue(undefined);
      vi.spyOn(app.adapters.codexDesktop, "openOrBindSession").mockImplementation(async (sessionKey) => ({
        sessionKey,
        codexThreadRef: `codex-thread:page-1:${sessionKey}`
      }));

      let activeTurns = 0;
      let maxConcurrentTurns = 0;
      const releaseQueue: Array<() => void> = [];

      vi.spyOn(app.adapters.codexDesktop, "sendUserMessage").mockImplementation(async () => {
        activeTurns += 1;
        maxConcurrentTurns = Math.max(maxConcurrentTurns, activeTurns);
        await new Promise<void>((resolve) => {
          releaseQueue.push(resolve);
        });
        activeTurns -= 1;
      });

      vi.spyOn(app.adapters.codexDesktop, "collectAssistantReply").mockResolvedValue([]);
      vi.spyOn(app.adapters.qq.egress, "deliver").mockResolvedValue({
        jobId: "job-lock",
        sessionKey: "qqbot:default::qq:c2c:session-a",
        providerMessageId: null,
        deliveredAt: "2026-04-19T14:00:00.000Z"
      });

      const turnA = app.orchestrator.handleInbound({
        messageId: "msg-lock-a",
        accountKey: "qqbot:default",
        sessionKey: "qqbot:default::qq:c2c:session-a",
        peerKey: "qq:c2c:session-a",
        chatType: "c2c",
        senderId: "session-a",
        text: "第一条并发消息",
        receivedAt: "2026-04-19T14:00:00.000Z"
      });

      const turnB = app.orchestrator.handleInbound({
        messageId: "msg-lock-b",
        accountKey: "qqbot:default",
        sessionKey: "qqbot:default::qq:c2c:session-b",
        peerKey: "qq:c2c:session-b",
        chatType: "c2c",
        senderId: "session-b",
        text: "第二条并发消息",
        receivedAt: "2026-04-19T14:00:00.500Z"
      });

      for (let attempt = 0; attempt < 50 && releaseQueue.length < 1; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(releaseQueue.length).toBe(1);
      expect(maxConcurrentTurns).toBe(1);

      releaseQueue.shift()?.();
      for (let attempt = 0; attempt < 50 && releaseQueue.length < 1; attempt += 1) {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(releaseQueue.length).toBe(1);

      releaseQueue.shift()?.();

      await Promise.all([turnA, turnB]);
      expect(maxConcurrentTurns).toBe(1);
    } finally {
      app.db.close();
      delete process.env.CODEX_DESKTOP_TRANSPORT;
    }
  });
});
