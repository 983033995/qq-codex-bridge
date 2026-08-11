import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { runWeixinWorker } from "../../apps/weixin-worker/src/index.js";
import {
  WEIXIN_WORKER_AUTH_ENV,
  WEIXIN_WORKER_PROTOCOL_VERSION,
  WeixinMessageError,
  type WeixinLoginState,
  type WorkerToDaemonMessage
} from "../../packages/channel-weixin/src/index.js";

describe("vNext Weixin worker runtime", () => {
  it("authenticates, negotiates, heartbeats, pings, and shuts down over IPC", async () => {
    const port = new FakeWorkerPort("worker-auth-token-with-at-least-32-bytes");
    const state = loginState("logged_out");
    const stateEmitter: { current?: (state: ReturnType<typeof loginState>) => void } = {};
    const runtime = runWeixinWorker(port, {
      handshakeTimeoutMs: 1_000,
      async createLoginManager(_configuration, onState) {
        stateEmitter.current = onState;
        return {
          getState: () => state,
          getCredential: async () => null,
          startLogin: async () => loginState("awaiting_scan"),
          logout: async () => loginState("logged_out"),
          invalidate: async () => loginState("logged_out"),
          stop: async () => undefined
        };
      }
    });

    expect(port.sent[0]).toMatchObject({
      type: "hello",
      authToken: "worker-auth-token-with-at-least-32-bytes",
      protocolVersion: WEIXIN_WORKER_PROTOCOL_VERSION,
      pid: 4242
    });
    expect(port.env[WEIXIN_WORKER_AUTH_ENV]).toBeUndefined();

    port.emit("message", {
      type: "initialize",
      protocolVersion: WEIXIN_WORKER_PROTOCOL_VERSION,
      daemonVersion: "0.2.0",
      heartbeatIntervalMs: 1_000,
      accounts: ["weixin:personal"],
      login: {
        stateFilePath: "/tmp/qqcb-vnext-weixin-login-runtime.json",
        baseUrl: "https://ilinkai.weixin.qq.com",
        botType: "3",
        qrFetchTimeoutMs: 10_000,
        qrPollTimeoutMs: 35_000,
        qrTotalTimeoutMs: 480_000
      },
      message: {
        stateFilePath: "/tmp/qqcb-vnext-weixin-message-runtime.json",
        longPollTimeoutMs: 35_000,
        apiTimeoutMs: 15_000,
        retryDelayMs: 2_000
      }
    });
    await eventually(() => port.sent.some((message) => message.type === "ready"));
    expect(port.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "ready", accounts: ["weixin:personal"] }),
      expect.objectContaining({ type: "heartbeat", sequence: 0 })
    ]));

    const pingId = "00000000-0000-4000-8000-000000000001";
    port.emit("message", { type: "ping", id: pingId, sentAt: new Date().toISOString() });
    expect(port.sent).toContainEqual(expect.objectContaining({ type: "pong", id: pingId }));

    const requestId = "00000000-0000-4000-8000-000000000002";
    port.emit("message", { type: "login.start", requestId, accountId: "weixin:personal", force: false });
    await tick();
    expect(port.sent).toContainEqual(expect.objectContaining({
      type: "command.result",
      requestId,
      ok: true,
      state: expect.objectContaining({ status: "awaiting_scan" })
    }));
    stateEmitter.current?.(loginState("scanned"));
    expect(port.sent).toContainEqual(expect.objectContaining({
      type: "login.state",
      state: expect.objectContaining({ status: "scanned" })
    }));

    runtime.stop();
    await tick();
    expect(port.sent).toContainEqual(expect.objectContaining({ type: "stopped" }));
    expect(port.connected).toBe(false);
  });

  it("restores logged-in message clients, forwards inbound messages, delivers replies, and stops on logout", async () => {
    const port = new FakeWorkerPort("worker-auth-token-with-at-least-32-bytes");
    let currentState: WeixinLoginState = {
      accountId: "weixin:personal",
      status: "logged_in" as const,
      message: "已登录",
      updatedAt: "2026-08-11T00:00:00.000Z"
    };
    let started = 0;
    let stopped = 0;
    let failDeliveryWithInvalidAuth = false;
    const deliveries: unknown[] = [];
    const runtime = runWeixinWorker(port, {
      handshakeTimeoutMs: 1_000,
      async createLoginManager() {
        return {
          getState: () => currentState,
          getCredential: async () => ({ token: "secret-token", baseUrl: "https://ilinkai.weixin.qq.com" }),
          startLogin: async () => currentState,
          logout: async () => {
            currentState = {
              accountId: "weixin:personal",
              status: "logged_out",
              message: "已注销",
              updatedAt: "2026-08-11T00:01:00.000Z"
            };
            return currentState;
          },
          invalidate: async () => {
            currentState = {
              accountId: "weixin:personal",
              status: "invalid",
              message: "登录已失效",
              updatedAt: "2026-08-11T00:01:00.000Z"
            };
            return currentState;
          },
          stop: async () => undefined
        };
      },
      async createMessageState() {
        return {
          getCursor: () => "",
          setCursor: async () => undefined,
          getContextToken: () => "",
          setContextToken: async () => undefined
        };
      },
      createMessageClient(input) {
        return {
          start() {
            started += 1;
            void input.onMessage({
              accountId: "weixin:personal",
              providerMessageId: "provider-inbound-1",
              senderId: "peer-1",
              peerId: "peer-1",
              chatType: "c2c",
              sequence: 1,
              receivedAt: "2026-08-11T00:00:01.000Z",
              text: "hello",
              attachments: [{
                id: "attachment-inbound-1",
                kind: "image",
                localPath: "/tmp/image.jpg",
                mimeType: "image/jpeg",
                size: 10,
                name: "image.jpg"
              }]
            });
          },
          async stop() { stopped += 1; },
          async deliver(delivery) {
            if (failDeliveryWithInvalidAuth) {
              throw new WeixinMessageError(
                "WEIXIN_AUTH_INVALID",
                false,
                "authentication failed"
              );
            }
            deliveries.push(delivery);
            return "provider-outbound-1";
          }
        };
      }
    });

    port.emit("message", initializeMessage());
    await tick();
    await tick();
    expect(started).toBe(1);
    expect(port.sent).toContainEqual(expect.objectContaining({
      type: "message.inbound",
      message: expect.objectContaining({
        providerMessageId: "provider-inbound-1",
        text: "hello",
        attachments: [expect.objectContaining({ id: "attachment-inbound-1" })]
      })
    }));
    const inboundRequest = port.sent.find((message) => message.type === "message.inbound");
    expect(inboundRequest?.type).toBe("message.inbound");
    if (inboundRequest?.type === "message.inbound") {
      port.emit("message", {
        type: "message.inbound.ack",
        requestId: inboundRequest.requestId,
        ok: true
      });
      await tick();
    }

    const deliveryRequestId = "00000000-0000-4000-8000-000000000003";
    port.emit("message", {
      type: "message.deliver",
      requestId: deliveryRequestId,
      delivery: {
        deliveryKey: "delivery-1",
        accountId: "weixin:personal",
        peerId: "peer-1",
        chatType: "c2c",
        text: "reply",
        attachments: [{
          id: "attachment-outbound-1",
          kind: "file",
          localPath: "/tmp/report.txt",
          mimeType: "text/plain",
          size: 12,
          name: "report.txt"
        }]
      }
    });
    await tick();
    expect(deliveries).toContainEqual(expect.objectContaining({
      deliveryKey: "delivery-1",
      text: "reply",
      attachments: [expect.objectContaining({ id: "attachment-outbound-1" })]
    }));
    expect(port.sent).toContainEqual({
      type: "delivery.result",
      requestId: deliveryRequestId,
      ok: true,
      providerMessageId: "provider-outbound-1"
    });

    failDeliveryWithInvalidAuth = true;
    const invalidRequestId = "00000000-0000-4000-8000-000000000005";
    port.emit("message", {
      type: "message.deliver",
      requestId: invalidRequestId,
      delivery: {
        deliveryKey: "delivery-invalid",
        accountId: "weixin:personal",
        peerId: "peer-1",
        chatType: "c2c",
        text: "reply"
      }
    });
    await tick();
    await tick();
    expect(port.sent).toContainEqual({
      type: "delivery.result",
      requestId: invalidRequestId,
      ok: false,
      error: {
        code: "WEIXIN_AUTH_INVALID",
        message: "微信登录已失效，请重新扫码",
        retryable: false
      }
    });
    expect(currentState.status).toBe("invalid");
    expect(stopped).toBe(1);

    port.emit("message", {
      type: "login.logout",
      requestId: "00000000-0000-4000-8000-000000000004",
      accountId: "weixin:personal"
    });
    await tick();
    expect(stopped).toBe(1);
    runtime.stop();
    await tick();
  });

  it("fails loudly without an authenticated IPC channel", () => {
    const port = new FakeWorkerPort("");
    expect(() => runWeixinWorker(port)).toThrow(WEIXIN_WORKER_AUTH_ENV);
    expect(() => runWeixinWorker({ ...port, send: undefined } as never)).toThrow("IPC channel");
  });
});

class FakeWorkerPort extends EventEmitter {
  readonly pid = 4242;
  readonly env: NodeJS.ProcessEnv;
  connected = true;
  exitCode: string | number | null = null;
  readonly sent: WorkerToDaemonMessage[] = [];

  constructor(token: string) {
    super();
    this.env = { [WEIXIN_WORKER_AUTH_ENV]: token };
  }

  send(message: WorkerToDaemonMessage, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    queueMicrotask(() => callback?.(null));
    return true;
  }

  disconnect(): void {
    this.connected = false;
    this.emit("disconnect");
  }
}

function loginState(status: "logged_out" | "awaiting_scan" | "scanned") {
  return {
    accountId: "weixin:personal",
    status,
    message: status,
    updatedAt: "2026-08-11T00:00:00.000Z",
    ...(status === "awaiting_scan" ? { qrCodeContent: "qr-content" } : {})
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function eventually(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Condition was not met before timeout");
    await tick();
  }
}

function initializeMessage() {
  return {
    type: "initialize" as const,
    protocolVersion: WEIXIN_WORKER_PROTOCOL_VERSION,
    daemonVersion: "0.2.0",
    heartbeatIntervalMs: 1_000,
    accounts: ["weixin:personal"],
    login: {
      stateFilePath: "/tmp/qqcb-vnext-weixin-login-runtime.json",
      baseUrl: "https://ilinkai.weixin.qq.com",
      botType: "3",
      qrFetchTimeoutMs: 10_000,
      qrPollTimeoutMs: 35_000,
      qrTotalTimeoutMs: 480_000
    },
    message: {
      stateFilePath: "/tmp/qqcb-vnext-weixin-message-runtime.json",
      longPollTimeoutMs: 35_000,
      apiTimeoutMs: 15_000,
      retryDelayMs: 2_000
    }
  };
}
