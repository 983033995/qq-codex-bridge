import path from "node:path";
import WebSocket from "ws";
import type { CodexThread, MessageContent } from "../../domain/src/vnext/index.js";
import type {
  CodexCapabilities,
  CodexControlState,
  CodexHealth,
  CodexPort,
  CodexTurnHandle,
  CodexTurnResult,
  CreateThreadInput,
  ListThreadsInput,
  StartCodexTurnInput
} from "../../ports/src/vnext/index.js";
import {
  DefaultAppServerEndpointProvider,
  type AppServerEndpointProvider
} from "./endpoint-provider.js";

type AppServerSocket = {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  off?(event: "open" | "error", listener: (...args: never[]) => void): unknown;
};

type JsonRpcResponse = {
  id: string | number;
  result?: unknown;
  error?: unknown;
};

type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

type PendingRequest = {
  method: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timeout: NodeJS.Timeout;
};

type PendingTurn = {
  threadId: string;
  turnId: string;
  deltaText: string;
  finalText: string | null;
  mediaReferences: Set<string>;
  seenNotifications: Set<string>;
  settled: boolean;
  resolve(result: CodexTurnResult): void;
  reject(error: unknown): void;
};

export type AppServerErrorCode =
  | "disposed"
  | "connect_failed"
  | "connection_closed"
  | "request_timeout"
  | "rpc_error"
  | "protocol_error"
  | "thread_not_found"
  | "turn_interrupted"
  | "turn_failed";

export class AppServerError extends Error {
  constructor(
    message: string,
    readonly code: AppServerErrorCode,
    readonly accepted: boolean,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "AppServerError";
  }
}

export type CodexAppServerAdapterOptions = {
  appServerUrl?: string | null;
  codexBinaryPath?: string;
  endpointProvider?: AppServerEndpointProvider;
  createWebSocket?: (url: string) => AppServerSocket;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  reconnectDelaysMs?: readonly number[];
  now?: () => Date;
};

const CAPABILITIES: CodexCapabilities = {
  listThreads: true,
  createThread: true,
  renameThread: true,
  forkThread: true,
  concurrentThreads: true,
  media: true
};

export class CodexAppServerAdapter implements CodexPort {
  private readonly endpointProvider: AppServerEndpointProvider;
  private readonly createWebSocket: (url: string) => AppServerSocket;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly reconnectDelaysMs: readonly number[];
  private readonly now: () => Date;
  private readonly pendingRequests = new Map<string | number, PendingRequest>();
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly earlyTurnNotifications = new Map<string, JsonRpcNotification[]>();
  private socket: AppServerSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private nextRequestId = 1;
  private reconnectAttempt = 0;
  private disposed = false;
  private state: "offline" | "connecting" | "ready" | "reconnecting" | "disposed" = "offline";
  private stateSince: string;
  private lastSuccessAt: string | undefined;
  private lastError: string | null = null;

  constructor(options: CodexAppServerAdapterOptions = {}) {
    this.endpointProvider = options.endpointProvider ?? new DefaultAppServerEndpointProvider({
      externalUrl: options.appServerUrl,
      codexBinaryPath: options.codexBinaryPath
    });
    this.createWebSocket = options.createWebSocket ?? ((url) => new WebSocket(url));
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? [250, 1_000, 2_000, 5_000];
    this.now = options.now ?? (() => new Date());
    this.stateSince = this.now().toISOString();
  }

  async health(): Promise<CodexHealth> {
    if (!this.disposed) {
      await this.ensureConnected().catch((error: unknown) => {
        this.lastError = errorMessage(error);
      });
    }
    const ready = this.state === "ready";
    return {
      component: "codex-appserver",
      status: ready ? "ready" : this.disposed ? "offline" : "degraded",
      code: ready ? undefined : this.disposed ? "APP_SERVER_DISPOSED" : "APP_SERVER_UNAVAILABLE",
      message: ready ? "Codex AppServer connected" : this.lastError ?? `Codex AppServer ${this.state}`,
      since: this.stateSince,
      lastSuccessAt: this.lastSuccessAt,
      suggestedAction: ready ? undefined : "Check the Codex desktop app and AppServer process",
      capabilities: { ...CAPABILITIES }
    };
  }

  async listThreads(input: ListThreadsInput): Promise<CodexThread[]> {
    validatePositiveInteger(input.limit, "limit");
    await this.ensureConnected();
    const response = asRecord(await this.request("thread/list", {
      limit: input.limit,
      cursor: input.cursor ?? null,
      sortKey: "updated_at"
    }));
    const rows = Array.isArray(response.data)
      ? response.data
      : Array.isArray(response.threads)
        ? response.threads
        : [];
    return rows.slice(0, input.limit).map(toCodexThread);
  }

  async createThread(input: CreateThreadInput): Promise<CodexThread> {
    await this.ensureConnected();
    const response = asRecord(await this.request("thread/start", {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      persistExtendedHistory: true,
      experimentalRawEvents: false
    }));
    const thread = toCodexThread(response.thread);
    if (input.title?.trim()) {
      await this.renameThread(thread.threadId, input.title);
      thread.title = input.title.trim();
    }
    return thread;
  }

  async renameThread(threadId: string, title: string): Promise<void> {
    requireNonEmpty(threadId, "threadId");
    const normalizedTitle = requireNonEmpty(title, "title");
    await this.ensureConnected();
    await this.request("thread/name/set", { threadId, name: normalizedTitle });
  }

  async forkThread(threadId: string): Promise<CodexThread> {
    requireNonEmpty(threadId, "threadId");
    await this.ensureConnected();
    const response = asRecord(await this.request("thread/fork", { threadId }));
    return toCodexThread(response.thread);
  }

  async startTurn(input: StartCodexTurnInput): Promise<CodexTurnHandle> {
    requireNonEmpty(input.threadId, "threadId");
    requireNonEmpty(input.idempotencyKey, "idempotencyKey");
    await this.ensureConnected();
    const response = asRecord(await this.request("turn/start", {
      threadId: input.threadId,
      input: toAppServerInput(input.content),
      idempotencyKey: input.idempotencyKey
    }));
    const turn = asRecord(response.turn);
    const turnId = readString(turn.id);
    if (!turnId) {
      throw new AppServerError("Codex AppServer did not return a turn id", "protocol_error", false);
    }
    const responseThreadId = readString(turn.threadId);
    if (responseThreadId && responseThreadId !== input.threadId) {
      throw new AppServerError("Codex AppServer returned a mismatched thread id", "protocol_error", true);
    }

    let resolveCompletion!: (result: CodexTurnResult) => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<CodexTurnResult>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const pending: PendingTurn = {
      threadId: input.threadId,
      turnId,
      deltaText: "",
      finalText: null,
      mediaReferences: new Set<string>(),
      seenNotifications: new Set<string>(),
      settled: false,
      resolve: resolveCompletion,
      reject: rejectCompletion
    };
    const key = turnKey(input.threadId, turnId);
    this.pendingTurns.set(key, pending);
    for (const notification of this.earlyTurnNotifications.get(key) ?? []) {
      this.applyTurnNotification(pending, notification);
    }
    this.earlyTurnNotifications.delete(key);

    return {
      threadId: input.threadId,
      turnId,
      acceptedAt: this.now().toISOString(),
      completion
    };
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    requireNonEmpty(threadId, "threadId");
    requireNonEmpty(turnId, "turnId");
    await this.ensureConnected();
    await this.request("turn/interrupt", { threadId, turnId });
    const pending = this.pendingTurns.get(turnKey(threadId, turnId));
    if (pending && !pending.settled) {
      this.rejectTurn(
        pending,
        new AppServerError(`Codex turn '${turnId}' was interrupted`, "turn_interrupted", true)
      );
    }
  }

  async getControlState(): Promise<CodexControlState> {
    await this.ensureConnected();
    const [configResult, rateLimitResult] = await Promise.all([
      this.request("config/read", { includeLayers: false }).catch(() => null),
      this.request("account/rateLimits/read").catch(() => null)
    ]);
    const config = asRecord(asRecord(configResult).config);
    return {
      model: readString(config.model),
      reasoningEffort: readString(config.model_reasoning_effort),
      quotaSummary: formatQuotaSummary(rateLimitResult)
    };
  }

  async switchModel(model: string): Promise<CodexControlState> {
    const normalized = requireNonEmpty(model, "model");
    await this.ensureConnected();
    await this.request("config/value/write", {
      keyPath: "model",
      value: normalized,
      mergeStrategy: "replace"
    });
    return this.getControlState();
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.setState("disposed");
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const error = new AppServerError("Codex AppServer adapter disposed", "disposed", false);
    this.rejectAllPending(error);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    await this.endpointProvider.dispose();
  }

  private async ensureConnected(): Promise<void> {
    if (this.disposed) {
      throw new AppServerError("Codex AppServer adapter disposed", "disposed", false);
    }
    if (this.socket?.readyState === WebSocket.OPEN && this.state === "ready") {
      return;
    }
    if (!this.connectPromise) {
      this.connectPromise = this.connect().finally(() => {
        this.connectPromise = null;
      });
    }
    await this.connectPromise;
  }

  private async connect(): Promise<void> {
    this.setState(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");
    const endpoint = await this.endpointProvider.resolve();
    const socket = this.createWebSocket(endpoint.url);
    this.socket = socket;
    socket.on("message", (data) => this.handleSocketMessage(String(data)));
    socket.on("close", () => this.handleSocketClose(socket));
    socket.on("error", (error) => {
      this.lastError = error.message;
    });

    try {
      await waitForSocketOpen(socket, this.connectTimeoutMs);
      await this.request("initialize", {
        clientInfo: {
          name: "qq-codex-bridge-vnext",
          title: "QQ Codex Bridge vNext",
          version: "1.0.0"
        },
        capabilities: { experimentalApi: true }
      });
      this.reconnectAttempt = 0;
      this.lastError = null;
      this.lastSuccessAt = this.now().toISOString();
      this.setState("ready");
    } catch (error) {
      if (this.socket === socket) {
        this.socket = null;
      }
      socket.close();
      const normalized = new AppServerError(
        `Codex AppServer connection failed: ${errorMessage(error)}`,
        "connect_failed",
        false,
        error instanceof Error ? { cause: error } : undefined
      );
      this.lastError = normalized.message;
      this.setState("offline");
      throw normalized;
    }
  }

  private request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new AppServerError("Codex AppServer is not connected", "connection_closed", false)
      );
    }
    const id = this.nextRequestId++;
    const payload = params === undefined
      ? { jsonrpc: "2.0", id, method }
      : { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new AppServerError(
          `Codex AppServer request timed out: ${method}`,
          "request_timeout",
          false
        ));
      }, this.requestTimeoutMs);
      this.pendingRequests.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timeout
      });
      socket.send(JSON.stringify(payload));
    });
  }

  private handleSocketMessage(raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      this.lastError = "Codex AppServer returned invalid JSON";
      return;
    }
    const record = asRecord(message);
    if ((typeof record.id === "number" || typeof record.id === "string") && !record.method) {
      this.handleResponse(record as JsonRpcResponse);
      return;
    }
    const method = readString(record.method);
    if (method) {
      this.handleNotification({ method, params: record.params });
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.id);
    if (response.error !== undefined) {
      const code = isThreadNotFoundRpcError(response.error) ? "thread_not_found" : "rpc_error";
      pending.reject(new AppServerError(
        `Codex AppServer RPC failed (${pending.method}): ${formatRpcError(response.error)}`,
        code,
        false
      ));
    } else {
      pending.resolve(response.result);
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    if (!isTurnNotification(notification.method)) {
      return;
    }
    const params = asRecord(notification.params);
    const threadId = readString(params.threadId);
    const turnId = readString(params.turnId) ?? readString(asRecord(params.turn).id);
    if (!threadId || !turnId) {
      return;
    }
    const key = turnKey(threadId, turnId);
    const pending = this.pendingTurns.get(key);
    if (!pending) {
      this.queueEarlyTurnNotification(key, notification);
      return;
    }
    this.applyTurnNotification(pending, notification);
  }

  private applyTurnNotification(pending: PendingTurn, notification: JsonRpcNotification): void {
    if (pending.settled) {
      return;
    }
    const fingerprint = notificationFingerprint(notification);
    if (fingerprint) {
      if (pending.seenNotifications.has(fingerprint)) {
        return;
      }
      pending.seenNotifications.add(fingerprint);
    }
    const params = asRecord(notification.params);

    if (notification.method === "item/agentMessage/delta") {
      const delta = readString(params.delta);
      if (delta) {
        pending.deltaText += delta;
      }
      collectMediaReferences(params, pending.mediaReferences);
      return;
    }
    if (notification.method === "item/completed") {
      const item = asRecord(params.item);
      if (readString(item.type) === "agentMessage") {
        const text = readString(item.text);
        if (text !== null) {
          pending.finalText = text;
        }
        collectMediaReferences(item, pending.mediaReferences);
      }
      return;
    }
    if (notification.method === "turn/completed") {
      const turn = asRecord(params.turn);
      const status = readString(turn.status) ?? readString(params.status) ?? "completed";
      if (status === "completed") {
        this.resolveTurn(pending);
      } else if (status === "interrupted" || status === "cancelled") {
        this.rejectTurn(pending, new AppServerError(
          `Codex turn '${pending.turnId}' was interrupted`,
          "turn_interrupted",
          true
        ));
      } else {
        this.rejectTurn(pending, new AppServerError(
          `Codex turn '${pending.turnId}' failed with status '${status}'`,
          "turn_failed",
          true
        ));
      }
    }
  }

  private resolveTurn(pending: PendingTurn): void {
    if (pending.settled) {
      return;
    }
    pending.settled = true;
    this.pendingTurns.delete(turnKey(pending.threadId, pending.turnId));
    pending.resolve({
      threadId: pending.threadId,
      turnId: pending.turnId,
      finalText: pending.finalText ?? pending.deltaText,
      mediaReferences: [...pending.mediaReferences]
    });
  }

  private rejectTurn(pending: PendingTurn, error: unknown): void {
    if (pending.settled) {
      return;
    }
    pending.settled = true;
    this.pendingTurns.delete(turnKey(pending.threadId, pending.turnId));
    pending.reject(error);
  }

  private handleSocketClose(socket: AppServerSocket): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = null;
    const error = new AppServerError(
      "Codex AppServer connection closed",
      "connection_closed",
      false
    );
    this.rejectAllPending(error);
    if (!this.disposed) {
      this.lastError = error.message;
      this.setState("reconnecting");
      this.scheduleReconnect();
    }
  }

  private queueEarlyTurnNotification(key: string, notification: JsonRpcNotification): void {
    const queued = this.earlyTurnNotifications.get(key) ?? [];
    if (queued.length < 32) {
      queued.push(notification);
      this.earlyTurnNotifications.set(key, queued);
    }
    while (this.earlyTurnNotifications.size > 128) {
      const oldestKey = this.earlyTurnNotifications.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      this.earlyTurnNotifications.delete(oldestKey);
    }
  }

  private rejectAllPending(error: AppServerError): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    for (const pending of this.pendingTurns.values()) {
      this.rejectTurn(pending, new AppServerError(error.message, error.code, true));
    }
    this.pendingTurns.clear();
    this.earlyTurnNotifications.clear();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer || this.connectPromise) {
      return;
    }
    const delay = this.reconnectDelaysMs[
      Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1)
    ] ?? 5_000;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureConnected().catch((error: unknown) => {
        this.lastError = errorMessage(error);
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private setState(state: CodexAppServerAdapter["state"]): void {
    if (this.state !== state) {
      this.state = state;
      this.stateSince = this.now().toISOString();
    }
  }
}

function waitForSocketOpen(socket: AppServerSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("WebSocket open timed out"));
    }, timeoutMs);
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off?.("open", onOpen as (...args: never[]) => void);
      socket.off?.("error", onError as (...args: never[]) => void);
    };
    socket.on("open", onOpen);
    socket.on("error", onError);
  });
}

function toAppServerInput(content: MessageContent): unknown[] {
  const input: unknown[] = [{
    type: "text",
    text: content.text,
    text_elements: content.mentions.map((mention) => ({
      type: "mention",
      text: mention.displayName ?? mention.providerUserId
    }))
  }];
  for (const attachment of content.attachments) {
    if (attachment.kind === "image") {
      input.push({ type: "localImage", path: attachment.localPath });
    } else {
      input.push({
        type: "text",
        text: attachment.transcript
          ? `[${attachment.name ?? attachment.kind}] ${attachment.transcript}`
          : `[${attachment.name ?? attachment.kind}] ${attachment.localPath}`,
        text_elements: []
      });
    }
  }
  return input;
}

function toCodexThread(value: unknown): CodexThread {
  const thread = asRecord(value);
  const threadId = readString(thread.id) ?? readString(thread.threadId);
  if (!threadId) {
    throw new AppServerError("Codex AppServer returned a thread without an id", "protocol_error", false);
  }
  const cwd = readString(thread.cwd);
  return {
    threadId,
    title: readString(thread.name) ?? readString(thread.title) ?? threadId,
    projectName: cwd ? path.basename(cwd) : null,
    updatedAt: normalizeTimestamp(thread.updatedAt)
  };
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1_000;
    return new Date(milliseconds).toISOString();
  }
  return null;
}

function collectMediaReferences(value: unknown, target: Set<string>, key = ""): void {
  if (typeof value === "string") {
    if (/^(?:mediaReferences?|url|uri|path|localPath|sourceUrl)$/i.test(key) && isMediaReference(value)) {
      target.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectMediaReferences(entry, target, key);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    collectMediaReferences(child, target, childKey);
  }
}

function isMediaReference(value: string): boolean {
  return value.startsWith("/")
    || value.startsWith("file://")
    || value.startsWith("http://")
    || value.startsWith("https://")
    || value.startsWith("data:");
}

function formatQuotaSummary(value: unknown): string | null {
  const response = asRecord(value);
  const limits = asRecord(response.rateLimitsByLimitId).codex ?? response.rateLimits;
  if (!limits) {
    return null;
  }
  const serialized = JSON.stringify(limits);
  return serialized === "{}" ? null : serialized;
}

function notificationFingerprint(notification: JsonRpcNotification): string | null {
  const params = asRecord(notification.params);
  const eventId = readString(params.eventId);
  if (eventId) {
    return eventId;
  }
  return notification.method === "item/agentMessage/delta"
    ? null
    : `${notification.method}:${JSON.stringify(notification.params ?? null)}`;
}

function isTurnNotification(method: string): boolean {
  return method === "item/agentMessage/delta"
    || method === "item/completed"
    || method === "turn/completed";
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function validatePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
}

function formatRpcError(error: unknown): string {
  const record = asRecord(error);
  return readString(record.message) ?? JSON.stringify(error);
}

function isThreadNotFoundRpcError(error: unknown): boolean {
  const record = asRecord(error);
  const code = readString(record.code);
  const message = readString(record.message) ?? "";
  return code === "thread_not_found" || /(?:thread.*not found|unknown.*thread)/i.test(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
