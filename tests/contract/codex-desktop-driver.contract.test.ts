import { describe, expect, it, vi } from "vitest";
import { DesktopDriverError } from "../../packages/domain/src/driver.js";
import { CodexDesktopDriver } from "../../packages/adapters/codex-desktop/src/codex-desktop-driver.js";
import { parseAssistantReply } from "../../packages/adapters/codex-desktop/src/reply-parser.js";
import type { CdpSession } from "../../packages/adapters/codex-desktop/src/cdp-session.js";

describe("codex desktop driver contract", () => {
  it("extracts the latest assistant reply from a snapshot string", () => {
    const reply = parseAssistantReply(`
      User: hello
      Assistant: first reply
      Assistant: latest reply
    `);

    expect(reply).toBe("latest reply");
  });

  it("fails readiness when no inspectable page target exists", async () => {
    const driver = new CodexDesktopDriver({
      connect: vi.fn().mockResolvedValue({
        appName: "Codex",
        browserVersion: "Codex/1.0",
        browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
      }),
      listTargets: vi.fn().mockResolvedValue([])
    } as unknown as CdpSession);

    await expect(driver.ensureAppReady()).rejects.toEqual(
      new DesktopDriverError("Codex desktop app is not exposing any inspectable page target", "app_not_ready")
    );
  });

  it("binds a session to the first inspectable page target", async () => {
    const driver = new CodexDesktopDriver({
      connect: vi.fn().mockResolvedValue({
        appName: "Codex",
        browserVersion: "Codex/1.0",
        browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
      }),
      listTargets: vi.fn().mockResolvedValue([
        {
          id: "page-1",
          title: "Codex",
          type: "page",
          url: "app://codex"
        }
      ])
    } as unknown as CdpSession);

    await expect(driver.openOrBindSession("qqbot:default::qq:c2c:OPENID123", null)).resolves.toEqual({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "cdp-target:page-1"
    });
  });

  it("collects the latest assistant reply from page text via cdp evaluation", async () => {
    const evaluateOnPage = vi.fn().mockResolvedValue("User: hi\nAssistant: first\nAssistant: latest");
    const driver = new CodexDesktopDriver({
      connect: vi.fn().mockResolvedValue({
        appName: "Codex",
        browserVersion: "Codex/1.0",
        browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
      }),
      listTargets: vi.fn().mockResolvedValue([
        {
          id: "page-1",
          title: "Codex",
          type: "page",
          url: "app://codex"
        }
      ]),
      evaluateOnPage
    } as unknown as CdpSession);

    await expect(
      driver.collectAssistantReply({
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        codexThreadRef: "cdp-target:page-1"
      })
    ).resolves.toMatchObject([
      {
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        text: "latest"
      }
    ]);
    expect(evaluateOnPage).toHaveBeenCalledWith("document.body.innerText", "page-1");
  });

  it("polls until a new assistant reply appears after sending the user message", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce("User: previous\nAssistant: old reply")
      .mockResolvedValueOnce({ ok: true, reason: "pressed_enter" })
      .mockResolvedValueOnce("User: previous\nAssistant: old reply")
      .mockResolvedValueOnce("User: new message\nAssistant: fresh reply");
    const driver = new CodexDesktopDriver(
      {
        connect: vi.fn().mockResolvedValue({
          appName: "Codex",
          browserVersion: "Codex/1.0",
          browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
        }),
        listTargets: vi.fn().mockResolvedValue([
          {
            id: "page-1",
            title: "Codex",
            type: "page",
            url: "app://codex"
          }
        ]),
        evaluateOnPage
      } as unknown as CdpSession,
      {
        replyPollIntervalMs: 0,
        sleep: async () => undefined
      }
    );

    const binding = {
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "cdp-target:page-1"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      senderId: "OPENID123",
      text: "new message",
      receivedAt: "2026-04-09T12:00:00.000Z"
    });

    await expect(driver.collectAssistantReply(binding)).resolves.toMatchObject([
      {
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        text: "fresh reply"
      }
    ]);
    expect(evaluateOnPage).toHaveBeenNthCalledWith(1, "document.body.innerText", "page-1");
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("new message"),
      "page-1"
    );
    expect(evaluateOnPage).toHaveBeenNthCalledWith(3, "document.body.innerText", "page-1");
    expect(evaluateOnPage).toHaveBeenNthCalledWith(4, "document.body.innerText", "page-1");
  });
});
