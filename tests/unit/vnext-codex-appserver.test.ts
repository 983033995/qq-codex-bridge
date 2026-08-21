import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  AppServerError,
  CodexAppServerAdapter,
  DefaultAppServerEndpointProvider,
  discoverRunningAppServerUrlsFromProcessList,
  discoverUsableRunningAppServerUrlsFromProcessList,
  validateLocalAppServerUrl
} from "../../packages/codex-appserver/src/index.js";
import { FakeCodexAppServer } from "../support/fake-app-server.js";

describe("vNext Codex AppServer adapter", () => {
  it("maps real Thread ids and routes out-of-order Turn results with deduplicated media", async () => {
    const { adapter, server } = createHarness();
    const threadA = await adapter.createThread({ title: "A", cwd: "/tmp/project-a" });
    const threadB = await adapter.createThread({ title: "B", cwd: "/tmp/project-b" });

    expect((await adapter.listThreads({ limit: 10 })).map((thread) => thread.threadId)).toEqual([
      threadA.threadId,
      threadB.threadId
    ]);
    expect((await adapter.forkThread(threadA.threadId)).threadId).not.toBe(threadA.threadId);

    const turnA = await adapter.startTurn(turnInput(threadA.threadId, "turn-a"));
    const turnB = await adapter.startTurn(turnInput(threadB.threadId, "turn-b"));
    expect(server.socket.sent.filter((request) => request.method === "thread/resume").map((request) => request.params))
      .toEqual([
        { threadId: threadA.threadId, persistExtendedHistory: true },
        { threadId: threadB.threadId, persistExtendedHistory: true }
      ]);
    await expect(adapter.getTurnStatus(threadA.threadId, turnA.turnId)).resolves.toBe("running");
    server.emitTurnDelta(threadB.threadId, turnB.turnId, "B");
    server.emitTurnDelta(threadB.threadId, turnB.turnId, "B");
    server.completeTurn(threadB.threadId, turnB.turnId, { duplicateNotifications: true });
    server.emitTurnDelta(threadA.threadId, turnA.turnId, "draft-");
    server.socket.notify("item/completed", {
      threadId: threadA.threadId,
      turnId: turnA.turnId,
      item: {
        type: "agentMessage",
        id: "item-a",
        text: "A-final",
        mediaReferences: ["/tmp/a.png", "/tmp/a.png", "https://example.test/b.png"]
      }
    });
    server.socket.notify("turn/completed", {
      threadId: threadA.threadId,
      turn: { id: turnA.turnId, status: "completed" }
    });
    server.threads.get(threadA.threadId)!.turns
      .find((turn) => turn.id === turnA.turnId)!.status = "completed";

    await expect(turnB.completion).resolves.toMatchObject({
      threadId: threadB.threadId,
      turnId: turnB.turnId,
      finalText: "BB",
      mediaReferences: []
    });
    await expect(turnA.completion).resolves.toEqual({
      threadId: threadA.threadId,
      turnId: turnA.turnId,
      finalText: "A-final",
      mediaReferences: ["/tmp/a.png", "https://example.test/b.png"]
    });
    await expect(adapter.getTurnStatus(threadA.threadId, turnA.turnId)).resolves.toBe("completed");
    await expect(adapter.getTurnStatus(threadA.threadId, "missing-turn")).resolves.toBe("not_found");
    await adapter.dispose();
  });

  it("buffers a completion that arrives immediately after Turn acceptance", async () => {
    const server = new FakeCodexAppServer();
    server.socket.onRequest("turn/start", (request) => {
      const params = request.params as { threadId: string };
      server.socket.respond(request.id, { turn: { id: "turn-early", threadId: params.threadId } });
      server.socket.notify("item/agentMessage/delta", {
        threadId: params.threadId,
        turnId: "turn-early",
        itemId: "item-early",
        delta: "early-final"
      });
      server.socket.notify("turn/completed", {
        threadId: params.threadId,
        turn: { id: "turn-early", status: "completed" }
      });
    });
    const adapter = createAdapter([server]);
    const thread = await adapter.createThread({ title: "early" });
    const handle = await adapter.startTurn(turnInput(thread.threadId, "early-key"));

    await expect(handle.completion).resolves.toMatchObject({ finalText: "early-final" });
    await adapter.dispose();
  });

  it("includes AppServer Turn failure details in accepted Turn errors", async () => {
    const { adapter, server } = createHarness();
    const thread = await adapter.createThread({ title: "failed" });
    const handle = await adapter.startTurn(turnInput(thread.threadId, "failed-key"));
    server.socket.notify("turn/completed", {
      threadId: thread.threadId,
      turn: {
        id: handle.turnId,
        status: "failed",
        error: { message: "model is unavailable" }
      }
    });

    await expect(handle.completion).rejects.toMatchObject({
      code: "turn_failed",
      accepted: true,
      message: expect.stringContaining("model is unavailable")
    });
    await adapter.dispose();
  });

  it("fails accepted Turns immediately on disconnect and reconnects for later work", async () => {
    vi.useFakeTimers();
    try {
      const first = new FakeCodexAppServer();
      const second = new FakeCodexAppServer();
      let createdSockets = 0;
      const adapter = new CodexAppServerAdapter({
        endpointProvider: staticEndpointProvider(),
        createWebSocket: () => {
          createdSockets += 1;
          return (createdSockets === 1 ? first : second).connect() as never;
        },
        reconnectDelaysMs: [0],
        requestTimeoutMs: 1_000
      });
      const thread = await adapter.createThread({ title: "disconnect" });
      const handle = await adapter.startTurn(turnInput(thread.threadId, "disconnect-key"));

      first.socket.disconnect();
      await expect(handle.completion).rejects.toMatchObject({
        code: "connection_closed",
        accepted: true
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(createdSockets).toBe(2);
      expect((await adapter.health()).status).toBe("ready");
      await adapter.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects pending Request and Turn promises during dispose", async () => {
    const { adapter, server } = createHarness();
    const thread = await adapter.createThread({ title: "dispose" });
    const handle = await adapter.startTurn(turnInput(thread.threadId, "dispose-turn"));
    server.socket.dropNextRequest("thread/list");
    const pendingList = adapter.listThreads({ limit: 10 });
    await flushAsyncEvents();

    const completionAssertion = expect(handle.completion).rejects.toMatchObject({
      code: "disposed",
      accepted: true
    });
    const requestAssertion = expect(pendingList).rejects.toMatchObject({
      code: "disposed",
      accepted: false
    });
    await adapter.dispose();
    await Promise.all([completionAssertion, requestAssertion]);
  });

  it("reports capabilities and reads or changes the active model", async () => {
    const { adapter, server } = createHarness();
    let model = "gpt-5.4";
    server.socket.onRequest("config/read", (request) => {
      server.socket.respond(request.id, {
        config: { model, model_reasoning_effort: "high" }
      });
    });
    server.socket.onRequest("config/value/write", (request) => {
      model = (request.params as { value: string }).value;
      server.socket.respond(request.id, {});
    });
    server.socket.onRequest("account/rateLimits/read", (request) => {
      server.socket.respond(request.id, { rateLimits: { primary: { usedPercent: 20 } } });
    });

    await expect(adapter.health()).resolves.toMatchObject({
      status: "ready",
      capabilities: {
        listThreads: true,
        createThread: true,
        renameThread: true,
        forkThread: true,
        concurrentThreads: true,
        media: true
      }
    });
    await expect(adapter.getControlState()).resolves.toMatchObject({
      model: "gpt-5.4",
      reasoningEffort: "high"
    });
    await expect(adapter.switchModel("gpt-5.5")).resolves.toMatchObject({ model: "gpt-5.5" });
    await adapter.dispose();
  });

  it("times out a dropped JSON-RPC Request with a stable error", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, server } = createHarness({ requestTimeoutMs: 50 });
      await adapter.health();
      server.socket.dropNextRequest("thread/list");
      const request = adapter.listThreads({ limit: 1 });
      const assertion = expect(request).rejects.toMatchObject({
        code: "request_timeout",
        accepted: false
      });

      await vi.advanceTimersByTimeAsync(50);
      await assertion;
      await adapter.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies an AppServer Thread Not Found response for coordinator recovery", async () => {
    const { adapter, server } = createHarness();
    const thread = await adapter.createThread({ title: "missing" });
    server.socket.onRequest("thread/name/set", (request) => {
      server.socket.respondError(request.id, {
        code: "thread_not_found",
        message: `thread ${thread.threadId} not found`
      });
    });

    await expect(adapter.renameThread(thread.threadId, "new title")).rejects.toMatchObject({
      code: "thread_not_found",
      accepted: false
    });
    await adapter.dispose();
  });

  it("reconciles the AppServer interrupt response race only after confirming interrupted state", async () => {
    const { adapter, server } = createHarness();
    const thread = await adapter.createThread({ title: "interrupt-race" });
    const interrupted = await adapter.startTurn(turnInput(thread.threadId, "interrupt-race"));
    server.socket.onRequest("turn/interrupt", (request) => {
      server.socket.respondError(request.id, {
        code: -32600,
        message: "no active turn to interrupt"
      });
      setTimeout(() => {
        server.threads.get(thread.threadId)!.turns[0]!.status = "interrupted";
        server.socket.notify("turn/completed", {
          threadId: thread.threadId,
          turn: { id: interrupted.turnId, status: "interrupted" }
        });
      }, 10);
    });
    const interruptedCompletion = expect(interrupted.completion).rejects.toMatchObject({
      code: "turn_interrupted",
      accepted: true
    });

    await expect(adapter.interruptTurn(thread.threadId, interrupted.turnId)).resolves.toBeUndefined();
    await interruptedCompletion;

    const completed = await adapter.startTurn(turnInput(thread.threadId, "completed-race"));
    server.socket.onRequest("turn/interrupt", (request) => {
      server.threads.get(thread.threadId)!.turns[1]!.status = "completed";
      server.socket.respond(request.id, {});
    });
    const disposedCompletion = expect(completed.completion).rejects.toMatchObject({
      code: "disposed",
      accepted: true
    });

    await expect(adapter.interruptTurn(thread.threadId, completed.turnId)).rejects.toMatchObject({
      code: "interrupt_not_confirmed",
      accepted: true
    });
    await adapter.dispose();
    await disposedCompletion;
  });

  it("classifies approval server requests, responds with decisions, and observes resolved notifications", async () => {
    const server = new FakeCodexAppServer();
    const onApprovalRequest = vi.fn(async () => undefined);
    const onServerRequestResolved = vi.fn(async () => undefined);
    const adapter = new CodexAppServerAdapter({
      endpointProvider: staticEndpointProvider(),
      createWebSocket: () => server.connect() as never,
      requestTimeoutMs: 1_000,
      onApprovalRequest,
      onServerRequestResolved
    });
    await adapter.health();

    server.socket.request(71, "item/commandExecution/requestApproval", {
      threadId: "thread-approval",
      turnId: "turn-approval",
      itemId: "item-approval",
      reason: "verify the change",
      command: "pnpm test",
      cwd: "/workspace"
    });
    await flushAsyncEvents();
    expect(onApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({
      appServerRequestId: 71,
      method: "item/commandExecution/requestApproval",
      threadId: "thread-approval",
      command: "pnpm test"
    }));

    await adapter.resolveApprovalRequest({ requestId: 71, resolution: "approve" });
    expect(server.socket.responses).toContainEqual({
      jsonrpc: "2.0",
      id: 71,
      result: { decision: "accept" }
    });

    server.socket.notify("serverRequest/resolved", {
      threadId: "thread-approval",
      requestId: 71
    });
    await flushAsyncEvents();
    expect(onServerRequestResolved).toHaveBeenCalledWith({
      threadId: "thread-approval",
      requestId: 71
    });
    await adapter.dispose();
  });
});

describe("vNext AppServer endpoint discovery", () => {
  it("accepts only credential-free loopback ws URLs", () => {
    expect(validateLocalAppServerUrl("ws://127.0.0.1:4500")).toBe("ws://127.0.0.1:4500");
    expect(validateLocalAppServerUrl("ws://[::1]:4500")).toBe("ws://[::1]:4500");
    expect(() => validateLocalAppServerUrl("wss://example.com/app-server")).toThrow("loopback");
    expect(() => validateLocalAppServerUrl("ws://user:pass@127.0.0.1:4500")).toThrow("loopback");
  });

  it("extracts and deduplicates safe AppServer listeners from a process list", () => {
    expect(discoverRunningAppServerUrlsFromProcessList([
      "/Applications/ChatGPT.app/codex app-server --listen ws://127.0.0.1:4500",
      "/Applications/ChatGPT.app/codex app-server --listen=ws://127.0.0.1:4500",
      "/tmp/codex app-server --listen ws://example.com:4501",
      "/tmp/not-codex --listen ws://127.0.0.1:9999"
    ].join("\n"))).toEqual(["ws://127.0.0.1:4500"]);
  });

  it("skips discovered macOS AppServers whose process cwd no longer exists", async () => {
    const readCwd = vi.fn(async (pid: number) => pid === 101
      ? "/Volumes/deleted-worktree"
      : "/Volumes/live-worktree");
    await expect(discoverUsableRunningAppServerUrlsFromProcessList([
      "101 /Applications/Codex.app/codex app-server --listen ws://127.0.0.1:4500",
      "202 /Applications/Codex.app/codex app-server --listen ws://127.0.0.1:4501"
    ].join("\n"), readCwd, (value) => value === "/Volumes/live-worktree"))
      .resolves.toEqual(["ws://127.0.0.1:4501"]);
  });

  it("skips discovered AppServers from a different workspace", async () => {
    const readCwd = vi.fn(async (pid: number) => pid === 101
      ? "/Volumes/other-worktree"
      : "/Volumes/current-worktree");
    await expect(discoverUsableRunningAppServerUrlsFromProcessList([
      "101 /Applications/Codex.app/codex app-server --listen ws://127.0.0.1:4500",
      "202 /Applications/Codex.app/codex app-server --listen ws://127.0.0.1:4501"
    ].join("\n"), readCwd, () => true, "/Volumes/current-worktree"))
      .resolves.toEqual(["ws://127.0.0.1:4501"]);
  });

  it("starts and owns a managed AppServer when discovery fails", async () => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      killed: boolean;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.exitCode = null;
    child.killed = false;
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => {
      child.killed = true;
      return true;
    });
    const spawnFn = vi.fn(() => child as never);
    const waitForReady = vi.fn(async () => undefined);
    const provider = new DefaultAppServerEndpointProvider({
      codexBinaryPath: "/bin/echo",
      discover: async () => {
        throw new Error("ps unavailable");
      },
      getFreePort: async () => 4567,
      spawnFn,
      waitForReady
    });

    await expect(provider.resolve()).resolves.toEqual({
      url: "ws://127.0.0.1:4567",
      managed: true
    });
    expect(spawnFn).toHaveBeenCalledWith(
      "/bin/echo",
      ["app-server", "--listen", "ws://127.0.0.1:4567", "-c", "analytics.enabled=false"],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    expect(waitForReady).toHaveBeenCalledWith(4567, child);
    provider.dispose();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("terminates its managed AppServer when readiness probing fails", async () => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      killed: boolean;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.exitCode = null;
    child.killed = false;
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => {
      child.killed = true;
      return true;
    });
    const provider = new DefaultAppServerEndpointProvider({
      codexBinaryPath: "/bin/echo",
      discover: async () => [],
      getFreePort: async () => 4568,
      spawnFn: () => child as never,
      waitForReady: async () => {
        throw new Error("listener unavailable");
      }
    });

    await expect(provider.resolve()).rejects.toThrow("listener unavailable");
    expect(child.kill).toHaveBeenCalledOnce();
  });
});

function createHarness(options: { requestTimeoutMs?: number } = {}) {
  const server = new FakeCodexAppServer();
  return {
    server,
    adapter: new CodexAppServerAdapter({
      endpointProvider: staticEndpointProvider(),
      createWebSocket: () => server.connect() as never,
      requestTimeoutMs: options.requestTimeoutMs ?? 1_000,
      reconnectDelaysMs: [0]
    })
  };
}

function createAdapter(servers: FakeCodexAppServer[]): CodexAppServerAdapter {
  let index = 0;
  return new CodexAppServerAdapter({
    endpointProvider: staticEndpointProvider(),
    createWebSocket: () => servers[Math.min(index++, servers.length - 1)]!.connect() as never,
    requestTimeoutMs: 1_000,
    reconnectDelaysMs: [0]
  });
}

function staticEndpointProvider() {
  return {
    async resolve() {
      return { url: "ws://127.0.0.1:1", managed: false };
    },
    dispose() {}
  };
}

function turnInput(threadId: string, idempotencyKey: string) {
  return {
    threadId,
    idempotencyKey,
    content: { text: "hello", mentions: [], attachments: [] }
  };
}

async function flushAsyncEvents(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
