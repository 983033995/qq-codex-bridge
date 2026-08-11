import path from "node:path";
import {
  HttpWeixinLoginProvider,
  WeixinLoginManager,
  WeixinLoginStateStore,
  WeixinMessageClient,
  WeixinMessageError,
  WeixinMessageStateStore,
  WEIXIN_WORKER_AUTH_ENV,
  WEIXIN_WORKER_PROTOCOL_VERSION,
  WEIXIN_WORKER_VERSION,
  parseDaemonToWorkerMessage,
  type DaemonToWorkerMessage,
  type WeixinInboundTextMessage,
  type WeixinLoginCredential,
  type WeixinLoginState,
  type WeixinMessageState,
  type WeixinTextDelivery,
  type WorkerToDaemonMessage
} from "../../../packages/channel-weixin/src/index.js";
import { MacOsKeychainSecretStore } from "../../../packages/config/src/index.js";

export type WeixinWorkerProcessPort = {
  readonly pid: number;
  readonly env: NodeJS.ProcessEnv;
  readonly connected?: boolean;
  exitCode?: string | number | null;
  send?(message: WorkerToDaemonMessage, callback?: (error: Error | null) => void): boolean;
  disconnect?(): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "disconnect", listener: () => void): unknown;
  off(event: "message", listener: (message: unknown) => void): unknown;
  off(event: "disconnect", listener: () => void): unknown;
};

export type WeixinWorkerRuntime = {
  stop(reason?: string): void;
};

type WorkerLoginManager = Pick<
  WeixinLoginManager,
  "getState" | "getCredential" | "startLogin" | "logout" | "invalidate" | "stop"
>;
type WorkerMessageClient = Pick<WeixinMessageClient, "start" | "stop" | "deliver">;
type LoginConfiguration = Extract<DaemonToWorkerMessage, { type: "initialize" }>["login"];
type MessageConfiguration = Extract<DaemonToWorkerMessage, { type: "initialize" }>["message"];

export function runWeixinWorker(
  port: WeixinWorkerProcessPort = process,
  options: {
    handshakeTimeoutMs?: number;
    now?: () => Date;
    createLoginManager?(configuration: LoginConfiguration, onState: (state: WeixinLoginState) => void): Promise<WorkerLoginManager>;
    createMessageState?(configuration: MessageConfiguration): Promise<WeixinMessageState>;
    createMessageClient?(input: {
      accountId: string;
      credential: WeixinLoginCredential;
      state: WeixinMessageState;
      configuration: MessageConfiguration;
      onMessage(message: WeixinInboundTextMessage): Promise<void>;
      onError(error: Error): void;
    }): WorkerMessageClient;
  } = {}
): WeixinWorkerRuntime {
  if (!port.send) {
    throw new Error("Weixin worker requires a Node IPC channel");
  }
  const authToken = required(port.env[WEIXIN_WORKER_AUTH_ENV], WEIXIN_WORKER_AUTH_ENV);
  delete port.env[WEIXIN_WORKER_AUTH_ENV];
  const now = options.now ?? (() => new Date());
  const handshakeTimeoutMs = positiveInteger(options.handshakeTimeoutMs ?? 10_000, "handshakeTimeoutMs");
  const startedAt = now().toISOString();
  let initialized = false;
  let initializing = false;
  let stopped = false;
  let shuttingDown = false;
  let heartbeat: NodeJS.Timeout | null = null;
  let heartbeatSequence = 0;
  let loginManager: WorkerLoginManager | null = null;
  let messageState: WeixinMessageState | null = null;
  let messageConfiguration: MessageConfiguration | null = null;
  const messageClients = new Map<string, WorkerMessageClient>();
  const messageTransitions = new Map<string, Promise<void>>();

  const handshakeTimeout = setTimeout(() => fail("Daemon did not initialize the worker in time"), handshakeTimeoutMs);
  handshakeTimeout.unref();

  const onMessage = (value: unknown) => {
    void handleMessage(value);
  };
  const handleMessage = async (value: unknown) => {
    if (stopped) return;
    try {
      const message = parseDaemonToWorkerMessage(value);
      if (message.type === "initialize") {
        if (initialized || initializing) {
          throw new Error("Weixin worker was initialized more than once");
        }
        initializing = true;
        const createLoginManager = options.createLoginManager ?? createProductionLoginManager;
        loginManager = await createLoginManager(message.login, (state) => {
          send({ type: "login.state", state });
          void reconcileMessageClient(state.accountId).catch((error) => {
            sendMessageError(state.accountId, "WEIXIN_MESSAGE_CLIENT_SYNC_FAILED", error, true);
          });
        });
        messageConfiguration = message.message;
        const createMessageState = options.createMessageState ?? createProductionMessageState;
        messageState = await createMessageState(message.message);
        for (const accountId of message.accounts) {
          await reconcileMessageClient(accountId);
        }
        if (stopped) {
          await stopResources();
          return;
        }
        initialized = true;
        initializing = false;
        clearTimeout(handshakeTimeout);
        send({
          type: "ready",
          protocolVersion: WEIXIN_WORKER_PROTOCOL_VERSION,
          workerVersion: WEIXIN_WORKER_VERSION,
          startedAt,
          accounts: message.accounts
        });
        sendHeartbeat();
        heartbeat = setInterval(sendHeartbeat, message.heartbeatIntervalMs);
        heartbeat.unref();
        return;
      }
      if (message.type === "ping") {
        if (!initialized) {
          throw new Error("Weixin worker received ping before initialization");
        }
        send({ type: "pong", id: message.id, occurredAt: now().toISOString() });
        return;
      }
      if (message.type === "shutdown") {
        stop(message.reason);
        return;
      }
      if (!initialized || !loginManager) {
        throw new Error("Weixin worker received a command before initialization");
      }
      if (message.type === "message.deliver") {
        await handleDelivery(message.requestId, message.delivery);
        return;
      }
      try {
        const state = message.type === "login.start"
          ? await loginManager.startLogin(message.accountId, message.force)
          : message.type === "login.logout"
            ? await loginManager.logout(message.accountId)
            : loginManager.getState(message.accountId);
        await reconcileMessageClient(state.accountId);
        send({ type: "command.result", requestId: message.requestId, ok: true, state });
      } catch {
        send({
          type: "command.result",
          requestId: message.requestId,
          ok: false,
          error: { code: "WEIXIN_LOGIN_OPERATION_FAILED", message: "微信登录操作失败，请重试" }
        });
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  };
  const onDisconnect = () => {
    shuttingDown = true;
    cleanup();
    void stopResources().catch(() => undefined);
  };
  port.on("message", onMessage);
  port.on("disconnect", onDisconnect);
  send({
    type: "hello",
    authToken,
    protocolVersion: WEIXIN_WORKER_PROTOCOL_VERSION,
    workerVersion: WEIXIN_WORKER_VERSION,
    pid: port.pid
  });

  return { stop };

  function sendHeartbeat(): void {
    send({
      type: "heartbeat",
      sequence: heartbeatSequence,
      occurredAt: now().toISOString()
    });
    heartbeatSequence += 1;
  }

  function send(message: WorkerToDaemonMessage, callback?: () => void): void {
    if (stopped || !port.send || port.connected === false) return;
    port.send(message, (error) => {
      if (error) {
        fail(error.message);
        return;
      }
      callback?.();
    });
  }

  function sendAsync(message: WorkerToDaemonMessage): Promise<void> {
    if (stopped || !port.send || port.connected === false) {
      return Promise.reject(new Error("Weixin worker IPC channel is disconnected"));
    }
    return new Promise<void>((resolve, reject) => {
      port.send!(message, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async function handleDelivery(requestId: string, delivery: WeixinTextDelivery): Promise<void> {
    const client = messageClients.get(delivery.accountId);
    if (!client) {
      send({
        type: "delivery.result",
        requestId,
        ok: false,
        error: {
          code: "WEIXIN_NOT_LOGGED_IN",
          message: "微信账户尚未登录",
          retryable: false
        }
      });
      return;
    }
    try {
      const providerMessageId = await client.deliver(delivery);
      send({ type: "delivery.result", requestId, ok: true, providerMessageId });
    } catch (error) {
      const failure = deliveryFailure(error);
      send({
        type: "delivery.result",
        requestId,
        ok: false,
        error: {
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable
        }
      });
      sendMessageError(delivery.accountId, failure.code, error, failure.retryable);
      if (failure.code === "WEIXIN_AUTH_INVALID") {
        await loginManager?.invalidate(delivery.accountId);
        await reconcileMessageClient(delivery.accountId);
      }
    }
  }

  function reconcileMessageClient(accountId: string): Promise<void> {
    const previous = messageTransitions.get(accountId) ?? Promise.resolve();
    const pending = previous.then(
      () => reconcileMessageClientNow(accountId),
      () => reconcileMessageClientNow(accountId)
    );
    messageTransitions.set(accountId, pending);
    void pending.then(
      () => { if (messageTransitions.get(accountId) === pending) messageTransitions.delete(accountId); },
      () => { if (messageTransitions.get(accountId) === pending) messageTransitions.delete(accountId); }
    );
    return pending;
  }

  async function reconcileMessageClientNow(accountId: string): Promise<void> {
    const manager = loginManager;
    const state = messageState;
    const configuration = messageConfiguration;
    if (!manager || !state || !configuration) return;
    const loginState = manager.getState(accountId);
    const existing = messageClients.get(accountId);
    if (shuttingDown || loginState.status !== "logged_in") {
      if (existing) {
        messageClients.delete(accountId);
        await existing.stop();
      }
      return;
    }
    if (existing) return;
    const credential = await manager.getCredential(accountId);
    if (!credential) throw new Error(`Weixin account '${accountId}' has no stored credential`);
    const createMessageClient = options.createMessageClient ?? createProductionMessageClient;
    const client = createMessageClient({
      accountId,
      credential,
      state,
      configuration,
      onMessage: (message) => sendAsync({ type: "message.inbound", message }),
      onError: (error) => {
        const failure = pollFailure(error);
        sendMessageError(accountId, failure.code, error, failure.retryable);
        if (error instanceof WeixinMessageError && error.code === "WEIXIN_AUTH_INVALID") {
          void manager.invalidate(accountId).catch((invalidateError) => {
            sendMessageError(accountId, "WEIXIN_LOGIN_INVALIDATION_FAILED", invalidateError, false);
          });
        }
      }
    });
    messageClients.set(accountId, client);
    client.start();
  }

  async function stopResources(): Promise<void> {
    await Promise.allSettled([...messageTransitions.values()]);
    const clients = [...messageClients.values()];
    messageClients.clear();
    const results = await Promise.allSettled(clients.map((client) => client.stop()));
    await loginManager?.stop();
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, "Weixin message clients failed to stop");
  }

  function sendMessageError(accountId: string, code: string, error: unknown, retryable: boolean): void {
    const message = error instanceof Error ? error.message : String(error);
    send({
      type: "message.error",
      accountId,
      error: { code, message: message.slice(0, 256) || "微信消息操作失败", retryable }
    });
  }

  function stop(_reason = "Worker shutdown requested"): void {
    if (stopped) return;
    shuttingDown = true;
    clearTimeout(handshakeTimeout);
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    void stopResources().catch(() => undefined).finally(() => {
      const stoppedMessage: WorkerToDaemonMessage = {
        type: "stopped",
        occurredAt: now().toISOString()
      };
      port.send?.(stoppedMessage, () => {
        cleanup();
        port.disconnect?.();
      });
    });
  }

  function fail(_message: string): void {
    if (stopped) return;
    port.exitCode = 1;
    cleanup();
    port.disconnect?.();
  }

  function cleanup(): void {
    if (stopped) return;
    stopped = true;
    clearTimeout(handshakeTimeout);
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    port.off("message", onMessage);
    port.off("disconnect", onDisconnect);
  }
}

async function createProductionLoginManager(
  configuration: LoginConfiguration,
  onState: (state: WeixinLoginState) => void
): Promise<WorkerLoginManager> {
  return WeixinLoginManager.create({
    provider: new HttpWeixinLoginProvider({
      baseUrl: configuration.baseUrl,
      botType: configuration.botType,
      qrFetchTimeoutMs: configuration.qrFetchTimeoutMs,
      qrPollTimeoutMs: configuration.qrPollTimeoutMs
    }),
    secrets: new MacOsKeychainSecretStore(),
    stateStore: new WeixinLoginStateStore(configuration.stateFilePath),
    loginBaseUrl: configuration.baseUrl,
    qrTotalTimeoutMs: configuration.qrTotalTimeoutMs,
    onState
  });
}

async function createProductionMessageState(
  configuration: MessageConfiguration
): Promise<WeixinMessageState> {
  const state = new WeixinMessageStateStore(configuration.stateFilePath);
  await state.load();
  return state;
}

function createProductionMessageClient(input: {
  accountId: string;
  credential: WeixinLoginCredential;
  state: WeixinMessageState;
  configuration: MessageConfiguration;
  onMessage(message: WeixinInboundTextMessage): Promise<void>;
  onError(error: Error): void;
}): WorkerMessageClient {
  return new WeixinMessageClient({
    accountId: input.accountId,
    credential: input.credential,
    state: input.state,
    longPollTimeoutMs: input.configuration.longPollTimeoutMs,
    apiTimeoutMs: input.configuration.apiTimeoutMs,
    retryDelayMs: input.configuration.retryDelayMs,
    mediaDirectoryPath: path.join(path.dirname(input.configuration.stateFilePath), "weixin-media"),
    onMessage: input.onMessage,
    onError: input.onError
  });
}

function required(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function deliveryFailure(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof WeixinMessageError && error.code === "WEIXIN_AUTH_INVALID") {
    return { code: error.code, message: "微信登录已失效，请重新扫码", retryable: false };
  }
  if (error instanceof WeixinMessageError && !error.retryable) {
    return { code: error.code, message: "微信消息不符合渠道要求，无法发送", retryable: false };
  }
  return { code: "WEIXIN_DELIVERY_FAILED", message: "微信消息发送失败，请稍后重试", retryable: true };
}

function pollFailure(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof WeixinMessageError) {
    return { code: error.code, retryable: error.retryable };
  }
  return { code: "WEIXIN_MESSAGE_POLL_FAILED", retryable: true };
}
