import {
  HttpWeixinLoginProvider,
  WeixinLoginManager,
  WeixinLoginStateStore,
  WEIXIN_WORKER_AUTH_ENV,
  WEIXIN_WORKER_PROTOCOL_VERSION,
  WEIXIN_WORKER_VERSION,
  parseDaemonToWorkerMessage,
  type DaemonToWorkerMessage,
  type WeixinLoginState,
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

type WorkerLoginManager = Pick<WeixinLoginManager, "getState" | "startLogin" | "logout" | "stop">;
type LoginConfiguration = Extract<DaemonToWorkerMessage, { type: "initialize" }>["login"];

export function runWeixinWorker(
  port: WeixinWorkerProcessPort = process,
  options: {
    handshakeTimeoutMs?: number;
    now?: () => Date;
    createLoginManager?(configuration: LoginConfiguration, onState: (state: WeixinLoginState) => void): Promise<WorkerLoginManager>;
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
  let heartbeat: NodeJS.Timeout | null = null;
  let heartbeatSequence = 0;
  let loginManager: WorkerLoginManager | null = null;

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
        });
        if (stopped) {
          await loginManager.stop();
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
        throw new Error("Weixin worker received a login command before initialization");
      }
      try {
        const state = message.type === "login.start"
          ? await loginManager.startLogin(message.accountId, message.force)
          : message.type === "login.logout"
            ? await loginManager.logout(message.accountId)
            : loginManager.getState(message.accountId);
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
  const onDisconnect = () => cleanup();
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

  function stop(_reason = "Worker shutdown requested"): void {
    if (stopped) return;
    clearTimeout(handshakeTimeout);
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    void Promise.resolve(loginManager?.stop()).catch(() => undefined).finally(() => {
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
