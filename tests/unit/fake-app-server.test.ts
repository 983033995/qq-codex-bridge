import { describe, expect, it, vi } from "vitest";
import {
  FakeAppServerSocket,
  FakeCodexAppServer,
  type FakeJsonRpcMessage
} from "../support/fake-app-server.js";

describe("vNext Fake AppServer", () => {
  it("opens only after connect and always crosses an asynchronous boundary", async () => {
    const socket = new FakeAppServerSocket();
    const opened = vi.fn();
    socket.on("open", opened);

    expect(opened).not.toHaveBeenCalled();
    socket.connect();
    expect(opened).not.toHaveBeenCalled();

    await flushAsyncEvents();
    expect(opened).toHaveBeenCalledOnce();
  });

  it("simulates out-of-order responses, duplicate notifications, disconnect, and timeout", async () => {
    const socket = new FakeAppServerSocket();
    const messages: FakeJsonRpcMessage[] = [];
    const closed = vi.fn();
    socket.on("message", (raw: string) => messages.push(JSON.parse(raw) as FakeJsonRpcMessage));
    socket.on("close", closed);
    socket.connect();
    await flushAsyncEvents();

    socket.respond(2, { value: "second" });
    socket.respond(1, { value: "first" });
    socket.notify("turn/completed", { turnId: "turn-1" });
    socket.notify("turn/completed", { turnId: "turn-1" });
    socket.onRequest("will-timeout", (request) => socket.respond(request.id, {}));
    socket.dropNextRequest("will-timeout");
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "will-timeout" }));
    await flushAsyncEvents();

    expect(messages.map((message) => "id" in message ? message.id : message.method)).toEqual([
      2,
      1,
      "turn/completed",
      "turn/completed"
    ]);
    expect(messages.some((message) => "id" in message && message.id === 3)).toBe(false);

    socket.disconnect();
    expect(closed).not.toHaveBeenCalled();
    await flushAsyncEvents();
    expect(closed).toHaveBeenCalledOnce();
    expect(socket.readyState).toBe(3);
  });

  it("supports Thread Start/List/Rename/Fork and Turn Start/Delta/Complete/Interrupt", async () => {
    const server = new FakeCodexAppServer();
    const notifications: Array<{ method: string; params?: unknown }> = [];
    server.socket.on("message", (raw: string) => {
      const message = JSON.parse(raw) as FakeJsonRpcMessage;
      if ("method" in message) {
        notifications.push(message);
      }
    });
    server.connect();
    await flushAsyncEvents();

    const started = await request(server.socket, 1, "thread/start", {
      title: "Thread A",
      cwd: "/tmp/project"
    }) as { thread: { id: string; name: string } };
    const threadId = started.thread.id;
    expect(started.thread.name).toBe("Thread A");

    await request(server.socket, 2, "thread/name/set", { threadId, name: "Renamed A" });
    const listed = await request(server.socket, 3, "thread/list", {}) as {
      data: Array<{ id: string; name: string }>;
    };
    expect(listed.data).toMatchObject([{ id: threadId, name: "Renamed A" }]);

    const forked = await request(server.socket, 4, "thread/fork", { threadId }) as {
      thread: { id: string; name: string };
    };
    expect(forked.thread.id).not.toBe(threadId);
    expect(forked.thread.name).toBe("Renamed A (fork)");

    const startedTurn = await request(server.socket, 5, "turn/start", {
      threadId,
      input: [{ type: "text", text: "hello" }]
    }) as { turn: { id: string } };
    server.emitTurnDelta(threadId, startedTurn.turn.id, "answer");
    server.completeTurn(threadId, startedTurn.turn.id, { duplicateNotifications: true });

    const interruptedTurn = await request(server.socket, 6, "turn/start", { threadId, input: [] }) as {
      turn: { id: string };
    };
    await request(server.socket, 7, "turn/interrupt", {
      threadId,
      turnId: interruptedTurn.turn.id
    });
    await flushAsyncEvents();

    expect(notifications.map((notification) => notification.method)).toEqual(expect.arrayContaining([
      "thread/started",
      "thread/name/updated",
      "turn/started",
      "item/agentMessage/delta",
      "item/completed",
      "turn/completed"
    ]));
    expect(server.threads.get(threadId)?.turns).toMatchObject([
      { id: startedTurn.turn.id, status: "completed", text: "answer" },
      { id: interruptedTurn.turn.id, status: "interrupted" }
    ]);
  });
});

function request(
  socket: FakeAppServerSocket,
  id: number,
  method: string,
  params: unknown
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: string) => {
      const message = JSON.parse(raw) as FakeJsonRpcMessage;
      if (!("id" in message) || message.id !== id) {
        return;
      }
      socket.off("message", onMessage);
      if (message.error !== undefined) {
        reject(message.error);
      } else {
        resolve(message.result);
      }
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

async function flushAsyncEvents(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
