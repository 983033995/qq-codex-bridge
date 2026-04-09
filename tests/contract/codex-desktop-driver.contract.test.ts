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
      ]),
      evaluateOnPage: vi.fn().mockResolvedValue([
        {
          title: "线程 A",
          projectName: "skills",
          relativeTime: "2 小时",
          isCurrent: true
        }
      ])
    } as unknown as CdpSession);

    await expect(driver.openOrBindSession("qqbot:default::qq:c2c:OPENID123", null)).resolves.toEqual({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: expect.stringContaining("codex-thread:page-1:")
    });
  });

  it("preserves an existing target binding instead of rebinding to a stale sidebar thread", async () => {
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
      evaluateOnPage: vi.fn().mockResolvedValue([
        {
          title: "旧线程",
          projectName: "skills",
          relativeTime: "刚刚",
          isCurrent: true
        }
      ])
    } as unknown as CdpSession);

    await expect(
      driver.openOrBindSession("qqbot:default::qq:c2c:OPENID123", {
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        codexThreadRef: "cdp-target:page-1"
      })
    ).resolves.toEqual({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "cdp-target:page-1"
    });
  });

  it("lists recent real codex sidebar threads from the current desktop ui", async () => {
    const evaluateOnPage = vi.fn().mockResolvedValue([
      {
        title: "线程 A",
        projectName: "skills",
        relativeTime: "2 小时",
        isCurrent: true
      },
      {
        title: "线程 B",
        projectName: "Desktop",
        relativeTime: "1 天",
        isCurrent: false
      }
    ]);

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

    await expect(driver.listRecentThreads(20)).resolves.toEqual([
      {
        index: 1,
        title: "线程 A",
        projectName: "skills",
        relativeTime: "2 小时",
        isCurrent: true,
        threadRef: expect.stringContaining("codex-thread:page-1:")
      },
      {
        index: 2,
        title: "线程 B",
        projectName: "Desktop",
        relativeTime: "1 天",
        isCurrent: false,
        threadRef: expect.stringContaining("codex-thread:page-1:")
      }
    ]);
    expect(evaluateOnPage).toHaveBeenCalledWith(
      expect.stringContaining("data-thread-title"),
      "page-1"
    );
  });

  it("switches a qq session binding to a selected codex sidebar thread", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce([
        {
          title: "线程 A",
          projectName: "skills",
          relativeTime: "2 小时",
          isCurrent: false
        },
        {
          title: "线程 B",
          projectName: "skills",
          relativeTime: "1 天",
          isCurrent: true
        }
      ])
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce([
        {
          title: "线程 A",
          projectName: "skills",
          relativeTime: "刚刚",
          isCurrent: true
        },
        {
          title: "线程 B",
          projectName: "skills",
          relativeTime: "1 天",
          isCurrent: false
        }
      ]);

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

    const threads = await driver.listRecentThreads(20);
    await expect(
      driver.switchToThread("qqbot:default::qq:c2c:OPENID123", threads[0].threadRef)
    ).resolves.toEqual({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: threads[0].threadRef
    });
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("clicked_thread"),
      "page-1"
    );
  });

  it("creates a new thread only after a fresh thread context becomes active and keeps a target binding", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, reason: "clicked_new_thread" })
      .mockResolvedValueOnce({ ok: true, reason: "fresh_thread" });

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

    await expect(
      driver.createThread("qqbot:default::qq:c2c:OPENID123", "")
    ).resolves.toEqual({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "cdp-target:page-1"
    });
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("fresh_thread"),
      "page-1"
    );
  });

  it("does not fail thread creation when the seed prompt does not produce an assistant reply", async () => {
    const dispatchKeyEvent = vi.fn().mockResolvedValue(undefined);
    const insertText = vi.fn().mockResolvedValue(undefined);
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, reason: "clicked_new_thread" })
      .mockResolvedValueOnce({ ok: true, reason: "fresh_thread" })
      .mockResolvedValueOnce({ reply: null })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" });

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
        evaluateOnPage,
        dispatchKeyEvent,
        insertText
      } as unknown as CdpSession,
      {
        replyPollIntervalMs: 0,
        sleep: async () => undefined
      }
    );

    await expect(
      driver.createThread("qqbot:default::qq:c2c:OPENID123", "线程标题：测试新线程")
    ).resolves.toEqual({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "cdp-target:page-1"
    });
    expect(insertText).toHaveBeenCalledWith("线程标题：测试新线程", "page-1");
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

  it("prefers assistant reply units rendered by the current Codex desktop ui", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ reply: "current desktop reply" })
      .mockResolvedValueOnce({ reply: "current desktop reply" })
      .mockResolvedValueOnce({ reply: "current desktop reply" });
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
        text: "current desktop reply"
      }
    ]);
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("data-content-search-unit-key"),
      "page-1"
    );
    expect(evaluateOnPage).not.toHaveBeenCalledWith("document.body.innerText", "page-1");
  });

  it("polls until a new assistant reply appears after sending the user message", async () => {
    const dispatchKeyEvent = vi.fn().mockResolvedValue(undefined);
    const insertText = vi.fn().mockResolvedValue(undefined);
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ reply: "old reply" })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" })
      .mockResolvedValueOnce({ reply: "old reply" })
      .mockResolvedValueOnce({ reply: "fresh reply" })
      .mockResolvedValueOnce({ reply: "fresh reply" })
      .mockResolvedValueOnce({ reply: "fresh reply" });
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
        evaluateOnPage,
        dispatchKeyEvent,
        insertText
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
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("data-content-search-unit-key"),
      "page-1"
    );
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("[data-codex-composer"),
      "page-1"
    );
    expect(dispatchKeyEvent).toHaveBeenNthCalledWith(
      1,
      {
        type: "keyDown",
        commands: ["selectAll"]
      },
      "page-1"
    );
    expect(dispatchKeyEvent).toHaveBeenNthCalledWith(
      2,
      {
        type: "keyDown",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8
      },
      "page-1"
    );
    expect(dispatchKeyEvent).toHaveBeenNthCalledWith(
      3,
      {
        type: "keyUp",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8
      },
      "page-1"
    );
    expect(insertText).toHaveBeenCalledWith("new message", "page-1");
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("pointerdown"),
      "page-1"
    );
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("clicked_send_button"),
      "page-1"
    );
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("data-content-search-unit-key"),
      "page-1"
    );
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("data-content-search-unit-key"),
      "page-1"
    );
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      6,
      expect.stringContaining("data-content-search-unit-key"),
      "page-1"
    );
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      7,
      expect.stringContaining("data-content-search-unit-key"),
      "page-1"
    );
  });

  it("waits for the streamed assistant reply to stabilize before returning it", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ reply: "old reply" })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" })
      .mockResolvedValueOnce({ reply: "old reply" })
      .mockResolvedValueOnce({ reply: "新" })
      .mockResolvedValueOnce({ reply: "新的" })
      .mockResolvedValueOnce({ reply: "新的完整回复" })
      .mockResolvedValueOnce({ reply: "新的完整回复" })
      .mockResolvedValueOnce({ reply: "新的完整回复" });

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
        evaluateOnPage,
        dispatchKeyEvent: vi.fn().mockResolvedValue(undefined),
        insertText: vi.fn().mockResolvedValue(undefined)
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
      messageId: "msg-stream",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      senderId: "OPENID123",
      text: "请流式输出",
      receivedAt: "2026-04-09T12:30:00.000Z"
    });

    await expect(driver.collectAssistantReply(binding)).resolves.toMatchObject([
      {
        text: "新的完整回复"
      }
    ]);
  });

  it("treats a new assistant unit as a fresh reply even when the text matches the baseline", async () => {
    const dispatchKeyEvent = vi.fn().mockResolvedValue(undefined);
    const insertText = vi.fn().mockResolvedValue(undefined);
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ unitKey: "assistant-1", reply: "相同内容" })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" })
      .mockResolvedValueOnce({ unitKey: "assistant-2", reply: "相同内容" })
      .mockResolvedValueOnce({ unitKey: "assistant-2", reply: "相同内容" })
      .mockResolvedValueOnce({ unitKey: "assistant-2", reply: "相同内容" });

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
        evaluateOnPage,
        dispatchKeyEvent,
        insertText
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
      messageId: "msg-same-text-new-unit",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      senderId: "OPENID123",
      text: "请再回答一次同样的话",
      receivedAt: "2026-04-09T17:35:00.000Z"
    });

    await expect(driver.collectAssistantReply(binding)).resolves.toMatchObject([
      {
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        text: "相同内容"
      }
    ]);
  });

  it("captures media references rendered in the current codex assistant unit", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({
        unitKey: "assistant-media-1",
        reply: "这是你要的素材",
        mediaReferences: [
          "/tmp/qq-media/test-image.png",
          "https://example.com/test-audio.mp3"
        ]
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-media-1",
        reply: "这是你要的素材",
        mediaReferences: [
          "/tmp/qq-media/test-image.png",
          "https://example.com/test-audio.mp3"
        ]
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-media-1",
        reply: "这是你要的素材",
        mediaReferences: [
          "/tmp/qq-media/test-image.png",
          "https://example.com/test-audio.mp3"
        ]
      });
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
        text: "这是你要的素材",
        mediaArtifacts: [
          expect.objectContaining({
            localPath: "/tmp/qq-media/test-image.png"
          }),
          expect.objectContaining({
            sourceUrl: "https://example.com/test-audio.mp3"
          })
        ]
      }
    ]);
  });
});
