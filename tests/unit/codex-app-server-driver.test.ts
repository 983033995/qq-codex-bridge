import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerDriver } from "../../packages/adapters/codex-desktop/src/codex-app-server-driver.js";

class FakeAppServerSocket extends EventEmitter {
  readyState = 0;
  readonly sent: unknown[] = [];
  private readonly handlers = new Map<string, (message: Record<string, unknown>) => void>();

  constructor() {
    super();
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open");
    });
  }

  send(data: string): void {
    const message = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(message);
    const method = message.method;
    if (typeof method === "string") {
      this.handlers.get(method)?.(message);
    }
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  onRequest(method: string, handler: (message: Record<string, unknown>) => void): void {
    this.handlers.set(method, handler);
  }

  respond(id: unknown, result: unknown): void {
    this.emit("message", JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  notify(method: string, params: unknown): void {
    this.emit("message", JSON.stringify({ jsonrpc: "2.0", method, params }));
  }
}

describe("codex app-server driver", () => {
  it("routes replies by thread id and turn id instead of the active desktop UI", async () => {
    const socket = new FakeAppServerSocket();
    socket.onRequest("initialize", (message) => {
      socket.respond(message.id, {
        userAgent: "fake",
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "macos"
      });
    });
    socket.onRequest("thread/resume", (message) => {
      socket.respond(message.id, {});
    });
    socket.onRequest("thread/read", (message) => {
      socket.respond(message.id, {
        thread: {
          id: "thread-target",
          turns: []
        }
      });
    });
    socket.onRequest("turn/start", (message) => {
      socket.respond(message.id, {
        turn: {
          id: "turn-target"
        }
      });

      setTimeout(() => {
        socket.notify("item/agentMessage/delta", {
          threadId: "thread-other",
          turnId: "turn-other",
          itemId: "item-other",
          delta: "WRONG_THREAD_REPLY"
        });
        socket.notify("item/agentMessage/delta", {
          threadId: "thread-target",
          turnId: "turn-target",
          itemId: "item-target",
          delta: "RIGHT_REPLY"
        });
        socket.notify("item/completed", {
          threadId: "thread-other",
          turnId: "turn-other",
          item: {
            type: "agentMessage",
            id: "item-other",
            text: "WRONG_THREAD_REPLY",
            phase: "final_answer"
          }
        });
        socket.notify("item/completed", {
          threadId: "thread-target",
          turnId: "turn-target",
          item: {
            type: "agentMessage",
            id: "item-target",
            text: "RIGHT_REPLY",
            phase: "final_answer"
          }
        });
        socket.notify("turn/completed", {
          threadId: "thread-target",
          turn: {
            id: "turn-target",
            status: "completed"
          }
        });
      }, 0);
    });

    const driver = new CodexAppServerDriver({
      appServerUrl: "ws://127.0.0.1:1",
      createWebSocket: () => socket as never,
      replyTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      sleep: async () => undefined
    });
    const binding = {
      sessionKey: "qqbot:default::qq:c2c:user-1",
      codexThreadRef: "codex-app-thread:thread-target"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:user-1",
      chatType: "c2c",
      senderId: "user-1",
      text: "hello",
      receivedAt: "2026-04-21T14:30:00.000Z"
    });
    const drafts = await driver.collectAssistantReply(binding);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      sessionKey: binding.sessionKey,
      turnId: "turn-target",
      text: "RIGHT_REPLY"
    });
  });

  it("forwards app-server notifications to the desktop app ui in thread order", async () => {
    const socket = new FakeAppServerSocket();
    const forwarded: Array<{ method: string; params: unknown }> = [];
    socket.onRequest("initialize", (message) => {
      socket.respond(message.id, {
        userAgent: "fake",
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "macos"
      });
    });
    socket.onRequest("thread/resume", (message) => {
      socket.respond(message.id, {});
    });
    socket.onRequest("thread/read", (message) => {
      expect(message.params).toMatchObject({ threadId: "thread-target" });
      socket.respond(message.id, {
        thread: {
          id: "thread-target",
          name: "目标线程",
          cwd: "/Volumes/workspaces/qq-codex-bridge",
          updatedAt: Math.floor(Date.now() / 1000)
        }
      });
    });
    socket.onRequest("turn/start", (message) => {
      socket.respond(message.id, {
        turn: {
          id: "turn-target"
        }
      });
      socket.notify("turn/started", {
        threadId: "thread-target",
        turn: {
          id: "turn-target",
          status: "inProgress"
        }
      });
    });

    const driver = new CodexAppServerDriver({
      appServerUrl: "ws://127.0.0.1:1",
      createWebSocket: () => socket as never,
      notificationForwarder: {
        async forwardNotification(method, params) {
          forwarded.push({ method, params });
        }
      },
      requestTimeoutMs: 1_000,
      sleep: async () => undefined
    });
    const binding = {
      sessionKey: "qqbot:default::qq:c2c:user-1",
      codexThreadRef: "codex-app-thread:thread-target"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:user-1",
      chatType: "c2c",
      senderId: "user-1",
      text: "hello",
      receivedAt: "2026-04-21T14:30:00.000Z"
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(forwarded.map((entry) => entry.method)).toEqual([
      "thread/started",
      "turn/started"
    ]);
    expect(forwarded[0]?.params).toMatchObject({
      thread: {
        id: "thread-target",
        name: "目标线程"
      }
    });
  });

  it("interrupts a stale in-progress turn before starting a new message", async () => {
    const socket = new FakeAppServerSocket();
    socket.onRequest("initialize", (message) => {
      socket.respond(message.id, {
        userAgent: "fake",
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "macos"
      });
    });
    socket.onRequest("thread/resume", (message) => {
      socket.respond(message.id, {});
    });
    socket.onRequest("thread/read", (message) => {
      socket.respond(message.id, {
        thread: {
          id: "thread-target",
          turns: [
            {
              id: "turn-stale",
              status: "inProgress",
              startedAt: Math.floor((Date.now() - 60_000) / 1000)
            }
          ]
        }
      });
    });
    socket.onRequest("turn/interrupt", (message) => {
      socket.respond(message.id, {});
    });
    socket.onRequest("turn/start", (message) => {
      socket.respond(message.id, {
        turn: {
          id: "turn-target"
        }
      });
    });

    const driver = new CodexAppServerDriver({
      appServerUrl: "ws://127.0.0.1:1",
      createWebSocket: () => socket as never,
      requestTimeoutMs: 1_000,
      staleTurnInterruptMs: 1,
      sleep: async () => undefined
    });
    const binding = {
      sessionKey: "qqbot:default::qq:c2c:user-1",
      codexThreadRef: "codex-app-thread:thread-target"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:user-1",
      chatType: "c2c",
      senderId: "user-1",
      text: "hello",
      receivedAt: "2026-04-21T14:30:00.000Z"
    });

    const methods = socket.sent
      .map((message) => (message as { method?: string }).method)
      .filter(Boolean);
    expect(methods).toEqual([
      "initialize",
      "thread/resume",
      "thread/read",
      "turn/interrupt",
      "turn/start"
    ]);
  });

  it("cleans pending turns and interrupts app-server when reply collection times out", async () => {
    const socket = new FakeAppServerSocket();
    socket.onRequest("initialize", (message) => {
      socket.respond(message.id, {
        userAgent: "fake",
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "macos"
      });
    });
    socket.onRequest("thread/resume", (message) => {
      socket.respond(message.id, {});
    });
    socket.onRequest("thread/read", (message) => {
      socket.respond(message.id, {
        thread: {
          id: "thread-target",
          turns: []
        }
      });
    });
    socket.onRequest("turn/start", (message) => {
      socket.respond(message.id, {
        turn: {
          id: "turn-target"
        }
      });
    });
    socket.onRequest("turn/interrupt", (message) => {
      socket.respond(message.id, {});
    });

    const driver = new CodexAppServerDriver({
      appServerUrl: "ws://127.0.0.1:1",
      createWebSocket: () => socket as never,
      replyTimeoutMs: 5,
      requestTimeoutMs: 1_000,
      sleep: async () => undefined
    });
    const binding = {
      sessionKey: "qqbot:default::qq:c2c:user-1",
      codexThreadRef: "codex-app-thread:thread-target"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:user-1",
      chatType: "c2c",
      senderId: "user-1",
      text: "hello",
      receivedAt: "2026-04-21T14:30:00.000Z"
    });

    await expect(driver.collectAssistantReply(binding)).rejects.toThrow(
      "Codex app-server reply did not arrive before timeout"
    );
    await expect(driver.collectAssistantReply(binding)).rejects.toThrow(
      "Codex app-server has no pending turn"
    );
    expect(
      socket.sent.some((message) =>
        (message as { method?: string; params?: unknown }).method === "turn/interrupt"
      )
    ).toBe(true);
  });

  it("reads status from the bound app-server thread instead of the latest thread", async () => {
    const socket = new FakeAppServerSocket();
    socket.onRequest("initialize", (message) => {
      socket.respond(message.id, {
        userAgent: "fake",
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "macos"
      });
    });
    socket.onRequest("config/read", (message) => {
      socket.respond(message.id, {
        config: {
          model: "gpt-5.4",
          model_reasoning_effort: "high",
          approval_policy: "on-request",
          sandbox_mode: "workspace-write"
        }
      });
    });
    socket.onRequest("thread/read", (message) => {
      expect(message.params).toMatchObject({ threadId: "thread-bound" });
      socket.respond(message.id, {
        thread: {
          id: "thread-bound",
          name: "绑定线程",
          cwd: "/Volumes/workspaces/qq-codex-bridge",
          updatedAt: Math.floor(Date.now() / 1000),
          gitInfo: {
            branch: "codex/weixin-multi-channel"
          }
        }
      });
    });
    socket.onRequest("account/rateLimits/read", (message) => {
      socket.respond(message.id, {
        rateLimitsByLimitId: {
          codex: {
            primary: {
              usedPercent: 35,
              windowDurationMins: 300,
              resetsAt: 1776840688
            },
            secondary: {
              usedPercent: 5,
              windowDurationMins: 10080,
              resetsAt: 1777427488
            }
          }
        }
      });
    });
    socket.onRequest("thread/list", () => {
      throw new Error("status should not use latest thread when a bound app-server ref is available");
    });

    const driver = new CodexAppServerDriver({
      appServerUrl: "ws://127.0.0.1:1",
      createWebSocket: () => socket as never,
      requestTimeoutMs: 1_000,
      sleep: async () => undefined
    });

    const state = await driver.getControlState({
      sessionKey: "qqbot:default::qq:c2c:user-1",
      codexThreadRef: "codex-app-thread:thread-bound:stale-title"
    });

    expect(state).toMatchObject({
      threadTitle: "绑定线程",
      threadProjectName: "qq-codex-bridge",
      model: "gpt-5.4",
      reasoningEffort: "high",
      workspace: "qq-codex-bridge",
      branch: "codex/weixin-multi-channel",
      permissionMode: "on-request / workspace-write"
    });
    expect(state.threadRef).toMatch(/^codex-app-thread:thread-bound:/);
    expect(state.quotaSummary).toContain("5 小时 65%");
    expect(state.quotaSummary).toContain("1 周 95%");
  });

  it("suppresses noisy backend websocket reset logs from managed app-server stderr", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const driver = new CodexAppServerDriver();
    const logStderr = (driver as unknown as { logCodexAppServerStderr: (text: string) => void })
      .logCodexAppServerStderr.bind(driver);

    logStderr(
      "\u001B[2m2026-04-22T01:59:41Z\u001B[0m \u001B[31mERROR\u001B[0m " +
      "codex_api::endpoint::responses_websocket: failed to connect to websocket: " +
      "IO error: Connection reset by peer (os error 54), " +
      "url: wss://chatgpt.com/backend-api/codex/responses"
    );

    expect(warnSpy).not.toHaveBeenCalled();

    logStderr("unexpected app-server stderr");
    expect(warnSpy).toHaveBeenCalledWith(
      "[qq-codex-bridge] codex app-server stderr",
      { text: "unexpected app-server stderr" }
    );

    warnSpy.mockRestore();
  });
});
