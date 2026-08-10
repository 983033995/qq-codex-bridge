import {
  WEIXIN_WORKER_AUTH_ENV,
  WEIXIN_WORKER_PROTOCOL_VERSION,
  WEIXIN_WORKER_VERSION,
  parseDaemonToWorkerMessage,
  type WorkerToDaemonMessage
} from "../../../packages/channel-weixin/src/index.js";

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

export function runWeixinWorker(
  port: WeixinWorkerProcessPort = process,
  options: { handshakeTimeoutMs?: number; now?: () => Date } = {}
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
  let stopped = false;
  let heartbeat: NodeJS.Timeout | null = null;
  let heartbeatSequence = 0;

  const handshakeTimeout = setTimeout(() => fail("Daemon did not initialize the worker in time"), handshakeTimeoutMs);
  handshakeTimeout.unref();

  const onMessage = (value: unknown) => {
    if (stopped) return;
    try {
      const message = parseDaemonToWorkerMessage(value);
      if (message.type === "initialize") {
        if (initialized) {
          throw new Error("Weixin worker was initialized more than once");
        }
        initialized = true;
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
      stop(message.reason);
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
    const stoppedMessage: WorkerToDaemonMessage = {
      type: "stopped",
      occurredAt: now().toISOString()
    };
    port.send?.(stoppedMessage, () => {
      cleanup();
      port.disconnect?.();
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
