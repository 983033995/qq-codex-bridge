import { describe, expect, it, vi } from "vitest";
import { DesktopDriverError } from "../../packages/domain/src/driver.js";
import {
  TurnEventType,
  type OutboundDraft,
  type TurnEvent
} from "../../packages/domain/src/message.js";
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
        title: "线程 B",
        projectName: "Desktop",
        relativeTime: "1 天",
        isCurrent: false
      },
      {
        title: "线程 A",
        projectName: "skills",
        relativeTime: "2 小时",
        isCurrent: true
      },
      {
        title: "线程 C",
        projectName: "skills",
        relativeTime: "15 分钟",
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
        title: "线程 C",
        projectName: "skills",
        relativeTime: "15 分钟",
        isCurrent: false,
        threadRef: expect.stringContaining("codex-thread:page-1:")
      },
      {
        index: 2,
        title: "线程 A",
        projectName: "skills",
        relativeTime: "2 小时",
        isCurrent: true,
        threadRef: expect.stringContaining("codex-thread:page-1:")
      },
      {
        index: 3,
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

  it("reads model, quota and runtime controls from the current desktop ui", async () => {
    const evaluateOnPage = vi.fn().mockResolvedValue({
      model: "GPT-5.4",
      reasoningEffort: "高",
      workspace: "本地",
      branch: "codex/qq-codex-bridge",
      permissionMode: "完全访问权限",
      quotaSummary: "当前界面未显示明确额度，暂未识别到剩余配额。"
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

    await expect(driver.getControlState()).resolves.toEqual({
      model: "GPT-5.4",
      reasoningEffort: "高",
      workspace: "本地",
      branch: "codex/qq-codex-bridge",
      permissionMode: "完全访问权限",
      quotaSummary: "当前界面未显示明确额度，暂未识别到剩余配额。"
    });
    expect(evaluateOnPage).toHaveBeenCalledWith(
      expect.stringContaining("quotaSummary"),
      "page-1"
    );
  });

  it("switches model from the current desktop ui and returns refreshed control state", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        model: "GPT-5.4-Mini",
        reasoningEffort: "高",
        workspace: "本地",
        branch: "codex/qq-codex-bridge",
        permissionMode: "完全访问权限",
        quotaSummary: null
      });

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
        sleep: async () => undefined
      }
    );

    await expect(driver.switchModel("GPT-5.4-Mini")).resolves.toEqual({
      model: "GPT-5.4-Mini",
      reasoningEffort: "高",
      workspace: "本地",
      branch: "codex/qq-codex-bridge",
      permissionMode: "完全访问权限",
      quotaSummary: null
    });
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("model_option_not_found"),
      "page-1"
    );
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("quotaSummary"),
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

  it("retries composer submission with Enter when the first submit attempt is not confirmed", async () => {
    const dispatchKeyEvent = vi.fn().mockResolvedValue(undefined);
    const insertText = vi.fn().mockResolvedValue(undefined);
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ unitKey: "assistant-before", reply: "旧回复" })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: false, reason: "submit_not_confirmed" })
      .mockResolvedValueOnce({ submitted: true, reason: "entered_streaming_state" });

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
      evaluateOnPage,
      dispatchKeyEvent,
      insertText
    } as unknown as CdpSession);

    await expect(
      driver.sendUserMessage(
        {
          sessionKey: "qqbot:default::qq:c2c:OPENID123",
          codexThreadRef: "cdp-target:page-1"
        },
        {
          messageId: "msg-retry-submit",
          accountKey: "qqbot:default",
          sessionKey: "qqbot:default::qq:c2c:OPENID123",
          peerKey: "qq:c2c:OPENID123",
          chatType: "c2c",
          senderId: "OPENID123",
          text: "请帮我测试发送重试",
          receivedAt: "2026-04-10T11:00:00.000Z"
        }
      )
    ).resolves.toBeUndefined();

    expect(dispatchKeyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ key: "Enter", type: "keyDown" }),
      "page-1"
    );
    expect(dispatchKeyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ key: "Enter", type: "keyUp" }),
      "page-1"
    );
  });

  it("throws a submit_failed driver error when the composer text remains unsent", async () => {
    const dispatchKeyEvent = vi.fn().mockResolvedValue(undefined);
    const insertText = vi.fn().mockResolvedValue(undefined);
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ unitKey: "assistant-before", reply: "旧回复" })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: false, reason: "submit_not_confirmed" })
      .mockResolvedValueOnce({ submitted: false, reason: "submit_not_confirmed" });

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
      evaluateOnPage,
      dispatchKeyEvent,
      insertText
    } as unknown as CdpSession);

    await expect(
      driver.sendUserMessage(
        {
          sessionKey: "qqbot:default::qq:c2c:OPENID123",
          codexThreadRef: "cdp-target:page-1"
        },
        {
          messageId: "msg-submit-failed",
          accountKey: "qqbot:default",
          sessionKey: "qqbot:default::qq:c2c:OPENID123",
          peerKey: "qq:c2c:OPENID123",
          chatType: "c2c",
          senderId: "OPENID123",
          text: "这条消息应该触发 submit_failed",
          receivedAt: "2026-04-10T11:02:00.000Z"
        }
      )
    ).rejects.toEqual(
      new DesktopDriverError(
        "Codex desktop composer submit failed: submit_not_confirmed",
        "submit_failed"
      )
    );
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

  it("returns a media-only assistant reply even when the reply text is empty", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({
        unitKey: "assistant-media-only-1",
        reply: null,
        mediaReferences: [
          "/tmp/qq-media/only-image-a.png",
          "/tmp/qq-media/only-image-b.png"
        ],
        isStreaming: false
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-media-only-1",
        reply: null,
        mediaReferences: [
          "/tmp/qq-media/only-image-a.png",
          "/tmp/qq-media/only-image-b.png"
        ],
        isStreaming: false
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-media-only-1",
        reply: null,
        mediaReferences: [
          "/tmp/qq-media/only-image-a.png",
          "/tmp/qq-media/only-image-b.png"
        ],
        isStreaming: false
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
        text: "",
        mediaArtifacts: [
          expect.objectContaining({
            localPath: "/tmp/qq-media/only-image-a.png"
          }),
          expect.objectContaining({
            localPath: "/tmp/qq-media/only-image-b.png"
          })
        ]
      }
    ]);
  });

  it("keeps ordinary reference links in reply text instead of treating them as qq media uploads", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({
        unitKey: "assistant-links-1",
        reply: "参考：\n泸沽湖观景台行程资料\nhttps://example.com/yunnan.pdf\n澎湃：格姆女神山可俯瞰泸沽湖全貌\nhttps://m.thepaper.cn/baijiahao_22780218",
        mediaReferences: []
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-links-1",
        reply: "参考：\n泸沽湖观景台行程资料\nhttps://example.com/yunnan.pdf\n澎湃：格姆女神山可俯瞰泸沽湖全貌\nhttps://m.thepaper.cn/baijiahao_22780218",
        mediaReferences: []
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-links-1",
        reply: "参考：\n泸沽湖观景台行程资料\nhttps://example.com/yunnan.pdf\n澎湃：格姆女神山可俯瞰泸沽湖全貌\nhttps://m.thepaper.cn/baijiahao_22780218",
        mediaReferences: []
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
        text: "参考：\n泸沽湖观景台行程资料\nhttps://example.com/yunnan.pdf\n澎湃：格姆女神山可俯瞰泸沽湖全貌\nhttps://m.thepaper.cn/baijiahao_22780218"
      }
    ]);
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("link.textContent = replacement"),
      "page-1"
    );
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("normalizedHref && isLocalReference(normalizedHref)"),
      "page-1"
    );
  });

  it("preserves ordered list numbering when serializing rich codex replies", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({
        unitKey: "assistant-list-1",
        reply: "1. 白天阳光海滩\n2. 日落金色沙滩\n3. 热带海岛风",
        mediaReferences: []
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-list-1",
        reply: "1. 白天阳光海滩\n2. 日落金色沙滩\n3. 热带海岛风",
        mediaReferences: []
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-list-1",
        reply: "1. 白天阳光海滩\n2. 日落金色沙滩\n3. 热带海岛风",
        mediaReferences: []
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
        text: "1. 白天阳光海滩\n2. 日落金色沙滩\n3. 热带海岛风"
      }
    ]);
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("if (tagName === 'OL')"),
      "page-1"
    );
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("return String(index + 1) + '. ' + content;"),
      "page-1"
    );
  });

  it("serializes codex code blocks as fenced markdown before qq delivery", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({
        unitKey: "assistant-code-1",
        reply: [
          "下面给你一段 JavaScript 闭包示例代码：",
          "```javascript",
          "function createCounter() {",
          "  let count = 0;",
          "  return function () {",
          "    count++;",
          "    return count;",
          "  };",
          "}",
          "```"
        ].join("\n"),
        mediaReferences: []
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-code-1",
        reply: [
          "下面给你一段 JavaScript 闭包示例代码：",
          "```javascript",
          "function createCounter() {",
          "  let count = 0;",
          "  return function () {",
          "    count++;",
          "    return count;",
          "  };",
          "}",
          "```"
        ].join("\n"),
        mediaReferences: []
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-code-1",
        reply: [
          "下面给你一段 JavaScript 闭包示例代码：",
          "```javascript",
          "function createCounter() {",
          "  let count = 0;",
          "  return function () {",
          "    count++;",
          "    return count;",
          "  };",
          "}",
          "```"
        ].join("\n"),
        mediaReferences: []
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
        text: [
          "下面给你一段 JavaScript 闭包示例代码：",
          "```javascript",
          "function createCounter() {",
          "  let count = 0;",
          "  return function () {",
          "    count++;",
          "    return count;",
          "  };",
          "}",
          "```"
        ].join("\n")
      }
    ]);
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("if (tagName === 'PRE')"),
      "page-1"
    );
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("bg-token-text-code-block-background"),
      "page-1"
    );
  });

  it("waits for codex to finish generating even if the first sentence is already stable", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ reply: "old reply", isStreaming: false })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" })
      .mockResolvedValueOnce({ unitKey: "assistant-3", reply: "先给一句", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-3", reply: "先给一句", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-3", reply: "先给一句", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-3", reply: "先给一句\n完整结果", isStreaming: false })
      .mockResolvedValueOnce({ unitKey: "assistant-3", reply: "先给一句\n完整结果", isStreaming: false })
      .mockResolvedValueOnce({ unitKey: "assistant-3", reply: "先给一句\n完整结果", isStreaming: false });

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
      messageId: "msg-thinking-after-first-sentence",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      senderId: "OPENID123",
      text: "请先回答一句，再继续思考并补完整结果",
      receivedAt: "2026-04-09T19:40:00.000Z"
    });

    await expect(driver.collectAssistantReply(binding)).resolves.toMatchObject([
      {
        text: "先给一句\n完整结果"
      }
    ]);
  });

  it("falls back to the last observed assistant reply when completion polling times out", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ reply: "old reply", isStreaming: false })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" })
      .mockResolvedValueOnce({ unitKey: "assistant-timeout-1", reply: "这是已经生成出来的结果", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-timeout-1", reply: "这是已经生成出来的结果", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-timeout-1", reply: "这是已经生成出来的结果", isStreaming: true });

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
        replyPollAttempts: 3,
        maxReplyPollAttempts: 3,
        replyPollIntervalMs: 0,
        replyStablePolls: 3,
        sleep: vi.fn().mockResolvedValue(undefined)
      }
    );

    const binding = {
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "cdp-target:page-1"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-timeout-fallback",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      senderId: "OPENID123",
      text: "请回答",
      receivedAt: "2026-04-09T21:40:00.000Z"
    });

    await expect(driver.collectAssistantReply(binding)).resolves.toMatchObject([
      {
        text: "这是已经生成出来的结果"
      }
    ]);
  });

  it("emits incremental drafts while the assistant reply grows across multiple phases", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ reply: "old reply", isStreaming: false })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" })
      .mockResolvedValueOnce({ unitKey: "assistant-stream-1", reply: "先回一句", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-stream-1", reply: "先回一句", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-stream-1", reply: "先回一句", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-stream-1", reply: "先回一句\n继续补充", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-stream-1", reply: "先回一句\n继续补充", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-stream-1", reply: "先回一句\n继续补充", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-stream-1", reply: "先回一句\n继续补充\n最终结论", isStreaming: false })
      .mockResolvedValueOnce({ unitKey: "assistant-stream-1", reply: "先回一句\n继续补充\n最终结论", isStreaming: false });

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
        replyPollAttempts: 12,
        replyPollIntervalMs: 0,
        replyStablePolls: 2,
        sleep: async () => undefined
      }
    );

    const binding = {
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "cdp-target:page-1"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-incremental-stream",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      senderId: "OPENID123",
      text: "请分阶段回答",
      receivedAt: "2026-04-10T11:00:00.000Z"
    });

    const emitted: OutboundDraft[] = [];
    const finalDrafts = await driver.collectAssistantReply(binding, {
      onDraft: async (draft) => {
        emitted.push(draft);
      }
    });

    expect(emitted).toMatchObject([
      { text: "先回一句" },
      { text: "继续补充" },
      { text: "最终结论" }
    ]);
    expect(finalDrafts).toEqual([]);
  });

  it("emits turn events while collecting assistant reply", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ reply: "old reply", isStreaming: false })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" })
      .mockResolvedValueOnce({ unitKey: "assistant-turn-event-1", reply: "先回一句", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-turn-event-1", reply: "先回一句", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-turn-event-1", reply: "先回一句", isStreaming: true })
      .mockResolvedValueOnce({
        unitKey: "assistant-turn-event-1",
        reply: "先回一句\n最终结论",
        isStreaming: false
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-turn-event-1",
        reply: "先回一句\n最终结论",
        isStreaming: false
      });

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
        replyPollAttempts: 10,
        replyPollIntervalMs: 0,
        replyStablePolls: 2,
        partialReplyStablePolls: 2,
        sleep: async () => undefined
      }
    );

    const binding = {
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "cdp-target:page-1"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-turn-event-stream",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      senderId: "OPENID123",
      text: "请分阶段回答并结束",
      receivedAt: "2026-04-12T00:10:00.000Z"
    });

    const events: TurnEvent[] = [];
    const finalDrafts = await driver.collectAssistantReply(binding, {
      onTurnEvent: async (event) => {
        events.push(event);
      }
    });

    expect(finalDrafts).toMatchObject([
      {
        text: "先回一句\n最终结论"
      }
    ]);
    expect(events.some((event) => event.eventType === TurnEventType.Delta)).toBe(true);
    expect(events.at(-1)?.eventType).toBe(TurnEventType.Completed);
    expect(events.at(-1)?.payload.fullText).toContain("最终结论");
  });

  it("emits newly discovered media references through onDraft even when no new text arrives", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ reply: "old reply", isStreaming: false })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" })
      .mockResolvedValueOnce({
        unitKey: "assistant-media-delta-1",
        reply: "我先去外接硬盘里定位目录。",
        mediaReferences: [],
        isStreaming: true
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-media-delta-1",
        reply: "我先去外接硬盘里定位目录。",
        mediaReferences: [],
        isStreaming: true
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-media-delta-1",
        reply: "我先去外接硬盘里定位目录。",
        mediaReferences: [],
        isStreaming: true
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-media-delta-1",
        reply: "我先去外接硬盘里定位目录。",
        mediaReferences: [
          "/tmp/qq-media/final-a.png",
          "/tmp/qq-media/final-b.png"
        ],
        isStreaming: false
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-media-delta-1",
        reply: "我先去外接硬盘里定位目录。",
        mediaReferences: [
          "/tmp/qq-media/final-a.png",
          "/tmp/qq-media/final-b.png"
        ],
        isStreaming: false
      });

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
        replyPollAttempts: 10,
        replyPollIntervalMs: 0,
        replyStablePolls: 2,
        sleep: async () => undefined
      }
    );

    const binding = {
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "cdp-target:page-1"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-media-delta-stream",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      senderId: "OPENID123",
      text: "帮我把最终图片也发出来",
      receivedAt: "2026-04-10T11:05:00.000Z"
    });

    const emitted: OutboundDraft[] = [];
    const finalDrafts = await driver.collectAssistantReply(binding, {
      onDraft: async (draft) => {
        emitted.push(draft);
      }
    });

    expect(emitted).toMatchObject([
      { text: "我先去外接硬盘里定位目录。" },
      {
        text: "",
        mediaArtifacts: [
          expect.objectContaining({
            localPath: "/tmp/qq-media/final-a.png"
          }),
          expect.objectContaining({
            localPath: "/tmp/qq-media/final-b.png"
          })
        ]
      }
    ]);
    expect(finalDrafts).toEqual([]);
  });

  it("probes the composer button icon as a streaming fallback signal", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ reply: "old reply", isStreaming: false })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" })
      .mockResolvedValueOnce({ unitKey: "assistant-4", reply: "先给一句", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-4", reply: "先给一句\n完整结果", isStreaming: false })
      .mockResolvedValueOnce({ unitKey: "assistant-4", reply: "先给一句\n完整结果", isStreaming: false })
      .mockResolvedValueOnce({ unitKey: "assistant-4", reply: "先给一句\n完整结果", isStreaming: false });

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
      messageId: "msg-stop-icon-streaming",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      senderId: "OPENID123",
      text: "先回答一句，再继续思考",
      receivedAt: "2026-04-09T20:10:00.000Z"
    });

    await expect(driver.collectAssistantReply(binding)).resolves.toMatchObject([
      {
        text: "先给一句\n完整结果"
      }
    ]);
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("size-token-button-composer"),
      "page-1"
    );
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("M4.5 5.75C4.5 5.05964"),
      "page-1"
    );
  });

  it("keeps polling when the latest assistant unit still shows reconnecting activity", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ reply: "old reply", isStreaming: false })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" })
      .mockResolvedValueOnce({ unitKey: "assistant-reconnect-1", reply: "我先去外接硬盘里定位目录。", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-reconnect-1", reply: "我先去外接硬盘里定位目录。", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-reconnect-1", reply: "我先去外接硬盘里定位目录。", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-reconnect-1", reply: "我先去外接硬盘里定位目录。\n我在等全盘结果返回。", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-reconnect-1", reply: "我先去外接硬盘里定位目录。\n我在等全盘结果返回。", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-reconnect-1", reply: "我先去外接硬盘里定位目录。\n我在等全盘结果返回。", isStreaming: true })
      .mockResolvedValueOnce({
        unitKey: "assistant-reconnect-1",
        reply: [
          "我先去外接硬盘里定位目录。",
          "我在等全盘结果返回。",
          "<qqmedia>/tmp/a.png</qqmedia>",
          "<qqmedia>/tmp/b.png</qqmedia>"
        ].join("\n"),
        isStreaming: false
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-reconnect-1",
        reply: [
          "我先去外接硬盘里定位目录。",
          "我在等全盘结果返回。",
          "<qqmedia>/tmp/a.png</qqmedia>",
          "<qqmedia>/tmp/b.png</qqmedia>"
        ].join("\n"),
        isStreaming: false
      });

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
        replyPollAttempts: 12,
        replyPollIntervalMs: 0,
        replyStablePolls: 2,
        sleep: async () => undefined
      }
    );

    const binding = {
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "cdp-target:page-1"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-reconnecting-stream",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      senderId: "OPENID123",
      text: "帮我把图片都发给我",
      receivedAt: "2026-04-10T17:40:00.000Z"
    });

    const emitted: OutboundDraft[] = [];
    const finalDrafts = await driver.collectAssistantReply(binding, {
      onDraft: async (draft) => {
        emitted.push(draft);
      }
    });

    expect(emitted).toMatchObject([
      { text: "我先去外接硬盘里定位目录。" },
      { text: "我在等全盘结果返回。" },
      {
        text: "<qqmedia>/tmp/a.png</qqmedia>\n<qqmedia>/tmp/b.png</qqmedia>"
      }
    ]);
    expect(finalDrafts).toEqual([]);
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("assistantStatusMatcher"),
      "page-1"
    );
  });

  it("does not timeout while the assistant remains streaming before a late qqmedia result arrives", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ reply: "old reply", isStreaming: false })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" })
      .mockResolvedValueOnce({
        unitKey: "assistant-long-running-1",
        reply: "我先开始生成图片。",
        mediaReferences: [],
        isStreaming: true
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-long-running-1",
        reply: "我先开始生成图片。",
        mediaReferences: [],
        isStreaming: true
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-long-running-1",
        reply: "我先开始生成图片。\n图片正在生成，我检查一下成品文件。",
        mediaReferences: [],
        isStreaming: true
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-long-running-1",
        reply: "我先开始生成图片。\n图片正在生成，我检查一下成品文件。",
        mediaReferences: [],
        isStreaming: true
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-long-running-1",
        reply: [
          "我先开始生成图片。",
          "图片正在生成，我检查一下成品文件。",
          "按你的要求生成好了：",
          "<qqmedia>/tmp/final-image.jpg</qqmedia>"
        ].join("\n"),
        mediaReferences: [],
        isStreaming: false
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-long-running-1",
        reply: [
          "我先开始生成图片。",
          "图片正在生成，我检查一下成品文件。",
          "按你的要求生成好了：",
          "<qqmedia>/tmp/final-image.jpg</qqmedia>"
        ].join("\n"),
        mediaReferences: [],
        isStreaming: false
      });

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
        replyPollAttempts: 2,
        replyPollIntervalMs: 0,
        replyStablePolls: 2,
        partialReplyStablePolls: 2,
        sleep: async () => undefined
      }
    );

    const binding = {
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "cdp-target:page-1"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-long-running-media",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      senderId: "OPENID123",
      text: "帮我生成图片并发给我",
      receivedAt: "2026-04-10T21:30:00.000Z"
    });

    const emitted: OutboundDraft[] = [];
    const finalDrafts = await driver.collectAssistantReply(binding, {
      onDraft: async (draft) => {
        emitted.push(draft);
      }
    });

    expect(emitted.length).toBeGreaterThanOrEqual(1);
    expect(emitted.at(-1)?.text).toContain("按你的要求生成好了：");
    expect(emitted.at(-1)?.text).toContain("<qqmedia>/tmp/final-image.jpg</qqmedia>");
    expect(finalDrafts).toEqual([]);
  });
});
