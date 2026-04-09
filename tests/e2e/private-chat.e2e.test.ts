import { describe, expect, it, vi } from "vitest";
import { bootstrap } from "../../apps/bridge-daemon/src/bootstrap.js";

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

  it("persists and reuses the codex target binding across turns", async () => {
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
      vi.spyOn(app.adapters.codexDesktop, "sendUserMessage").mockResolvedValue(undefined);
      vi.spyOn(app.adapters.codexDesktop, "collectAssistantReply")
        .mockResolvedValueOnce([
          {
            draftId: "draft-1",
            sessionKey: "qqbot:default::qq:c2c:abc-123",
            text: "reply-1",
            createdAt: "2026-04-09T11:05:00.000Z"
          }
        ])
        .mockResolvedValueOnce([
          {
            draftId: "draft-2",
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
          codexThreadRef: "cdp-target:page-1"
        }
      );

      const stored = app.db
        .prepare(
          `SELECT codex_thread_ref AS codexThreadRef
           FROM bridge_sessions
           WHERE session_key = ?`
        )
        .get("qqbot:default::qq:c2c:abc-123") as { codexThreadRef: string | null } | undefined;

      expect(stored?.codexThreadRef).toBe("cdp-target:page-1");
    } finally {
      app.db.close();
    }
  });
});
