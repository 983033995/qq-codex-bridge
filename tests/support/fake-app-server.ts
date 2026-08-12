import { EventEmitter } from "node:events";

export type FakeJsonRpcRequest = {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
};

export type FakeJsonRpcMessage =
  | { jsonrpc: "2.0"; id: string | number; result?: unknown; error?: unknown }
  | { jsonrpc: "2.0"; method: string; params?: unknown };

type RequestHandler = (request: FakeJsonRpcRequest) => void | Promise<void>;

/**
 * A deterministic WebSocket test double that preserves the asynchronous
 * event boundary of a real socket. Tests must call connect() from their
 * createWebSocket factory, after the consumer is ready to register listeners.
 */
export class FakeAppServerSocket extends EventEmitter {
  readyState = 0;
  readonly sent: FakeJsonRpcRequest[] = [];
  private readonly handlers = new Map<string, RequestHandler>();
  private readonly droppedRequests = new Map<string, number>();
  private openScheduled = false;

  connect(): this {
    if (this.openScheduled || this.readyState !== 0) {
      return this;
    }
    this.openScheduled = true;
    queueMicrotask(() => {
      if (this.readyState !== 0) {
        return;
      }
      this.readyState = 1;
      this.emit("open");
    });
    return this;
  }

  send(data: string): void {
    const request = JSON.parse(data) as FakeJsonRpcRequest;
    this.sent.push(request);
    queueMicrotask(() => {
      if (this.readyState !== 1 || this.consumeDroppedRequest(request.method)) {
        return;
      }
      const handler = this.handlers.get(request.method);
      if (!handler) {
        return;
      }
      Promise.resolve(handler(request)).catch((error: unknown) => {
        this.emit("error", error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  close(): void {
    this.disconnect();
  }

  disconnect(): void {
    if (this.readyState === 2 || this.readyState === 3) {
      return;
    }
    this.readyState = 2;
    queueMicrotask(() => {
      this.readyState = 3;
      this.emit("close");
    });
  }

  fail(error: Error): void {
    queueMicrotask(() => this.emit("error", error));
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.handlers.set(method, handler);
  }

  dropNextRequest(method: string, count = 1): void {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error("drop count must be a positive integer");
    }
    this.droppedRequests.set(method, (this.droppedRequests.get(method) ?? 0) + count);
  }

  respond(id: string | number, result: unknown): void {
    this.emitMessage({ jsonrpc: "2.0", id, result });
  }

  respondError(id: string | number, error: unknown): void {
    this.emitMessage({ jsonrpc: "2.0", id, error });
  }

  notify(method: string, params?: unknown): void {
    this.emitMessage({ jsonrpc: "2.0", method, params });
  }

  private emitMessage(message: FakeJsonRpcMessage): void {
    queueMicrotask(() => {
      if (this.readyState === 1) {
        this.emit("message", JSON.stringify(message));
      }
    });
  }

  private consumeDroppedRequest(method: string): boolean {
    const remaining = this.droppedRequests.get(method) ?? 0;
    if (remaining === 0) {
      return false;
    }
    if (remaining === 1) {
      this.droppedRequests.delete(method);
    } else {
      this.droppedRequests.set(method, remaining - 1);
    }
    return true;
  }
}

export type FakeAppServerThread = {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  turns: FakeAppServerTurn[];
};

export type FakeAppServerTurn = {
  id: string;
  threadId: string;
  status: "inProgress" | "completed" | "interrupted";
  text: string;
};

/** Stateful protocol fixture used by vNext AppServer adapter tests. */
export class FakeCodexAppServer {
  readonly socket: FakeAppServerSocket;
  readonly threads = new Map<string, FakeAppServerThread>();
  private nextThreadId = 1;
  private nextTurnId = 1;
  private nextItemId = 1;

  constructor(socket = new FakeAppServerSocket()) {
    this.socket = socket;
    this.installHandlers();
  }

  connect(): FakeAppServerSocket {
    return this.socket.connect();
  }

  emitTurnDelta(threadId: string, turnId: string, delta: string): void {
    const turn = this.requireTurn(threadId, turnId);
    if (turn.status !== "inProgress") {
      throw new Error(`turn '${turnId}' is not in progress`);
    }
    turn.text += delta;
    this.socket.notify("item/agentMessage/delta", {
      threadId,
      turnId,
      itemId: `item-${this.nextItemId}`,
      delta
    });
  }

  completeTurn(
    threadId: string,
    turnId: string,
    options: { duplicateNotifications?: boolean } = {}
  ): void {
    const turn = this.requireTurn(threadId, turnId);
    turn.status = "completed";
    const itemId = `item-${this.nextItemId++}`;
    const item = {
      type: "agentMessage",
      id: itemId,
      text: turn.text,
      phase: "final_answer"
    };
    const completed = {
      threadId,
      turn: { id: turnId, status: "completed" }
    };
    this.socket.notify("item/completed", { threadId, turnId, item });
    this.socket.notify("turn/completed", completed);
    if (options.duplicateNotifications) {
      this.socket.notify("item/completed", { threadId, turnId, item });
      this.socket.notify("turn/completed", completed);
    }
  }

  private installHandlers(): void {
    this.socket.onRequest("initialize", (request) => {
      this.socket.respond(request.id, {
        userAgent: "fake-vnext-app-server",
        codexHome: "/tmp/fake-codex",
        platformFamily: "unix",
        platformOs: "macos"
      });
    });
    this.socket.onRequest("thread/start", (request) => {
      const params = asRecord(request.params);
      const id = `thread-${this.nextThreadId++}`;
      const now = Date.now();
      const thread: FakeAppServerThread = {
        id,
        name: readString(params.title) ?? `Thread ${id}`,
        cwd: readString(params.cwd) ?? "/tmp/fake-workspace",
        createdAt: now,
        updatedAt: now,
        turns: []
      };
      this.threads.set(id, thread);
      this.socket.respond(request.id, { thread: cloneThread(thread) });
      this.socket.notify("thread/started", { thread: cloneThread(thread) });
    });
    this.socket.onRequest("thread/list", (request) => {
      this.socket.respond(request.id, {
        data: [...this.threads.values()].map(cloneThread),
        nextCursor: null
      });
    });
    this.socket.onRequest("thread/read", (request) => {
      const thread = this.requireThread(readRequiredString(request.params, "threadId"));
      this.socket.respond(request.id, { thread: cloneThread(thread) });
    });
    this.socket.onRequest("thread/resume", (request) => {
      const thread = this.requireThread(readRequiredString(request.params, "threadId"));
      this.socket.respond(request.id, { thread: cloneThread(thread) });
    });
    this.socket.onRequest("thread/name/set", (request) => {
      const params = asRecord(request.params);
      const thread = this.requireThread(readRequiredString(params, "threadId"));
      thread.name = readRequiredString(params, "name");
      thread.updatedAt = Date.now();
      this.socket.respond(request.id, {});
      this.socket.notify("thread/name/updated", { threadId: thread.id, name: thread.name });
    });
    this.socket.onRequest("thread/fork", (request) => {
      const source = this.requireThread(readRequiredString(request.params, "threadId"));
      const id = `thread-${this.nextThreadId++}`;
      const now = Date.now();
      const thread: FakeAppServerThread = {
        ...source,
        id,
        name: `${source.name} (fork)`,
        createdAt: now,
        updatedAt: now,
        turns: source.turns.map((turn) => ({ ...turn, threadId: id }))
      };
      this.threads.set(id, thread);
      this.socket.respond(request.id, { thread: cloneThread(thread) });
      this.socket.notify("thread/started", { thread: cloneThread(thread) });
    });
    this.socket.onRequest("turn/start", (request) => {
      const thread = this.requireThread(readRequiredString(request.params, "threadId"));
      const id = `turn-${this.nextTurnId++}`;
      const turn: FakeAppServerTurn = {
        id,
        threadId: thread.id,
        status: "inProgress",
        text: ""
      };
      thread.turns.push(turn);
      thread.updatedAt = Date.now();
      this.socket.respond(request.id, { turn: { ...turn } });
      this.socket.notify("turn/started", {
        threadId: thread.id,
        turn: { id, status: "inProgress" }
      });
    });
    this.socket.onRequest("turn/interrupt", (request) => {
      const params = asRecord(request.params);
      const turn = this.requireTurn(
        readRequiredString(params, "threadId"),
        readRequiredString(params, "turnId")
      );
      turn.status = "interrupted";
      this.socket.respond(request.id, {});
      this.socket.notify("turn/completed", {
        threadId: turn.threadId,
        turn: { id: turn.id, status: "interrupted" }
      });
    });
  }

  private requireThread(threadId: string): FakeAppServerThread {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new Error(`unknown fake thread '${threadId}'`);
    }
    return thread;
  }

  private requireTurn(threadId: string, turnId: string): FakeAppServerTurn {
    const turn = this.requireThread(threadId).turns.find((candidate) => candidate.id === turnId);
    if (!turn) {
      throw new Error(`unknown fake turn '${turnId}'`);
    }
    return turn;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readRequiredString(value: unknown, key: string): string {
  const result = readString(asRecord(value)[key]);
  if (!result) {
    throw new Error(`missing fake AppServer parameter '${key}'`);
  }
  return result;
}

function cloneThread(thread: FakeAppServerThread): FakeAppServerThread {
  return {
    ...thread,
    turns: thread.turns.map((turn) => ({ ...turn }))
  };
}
