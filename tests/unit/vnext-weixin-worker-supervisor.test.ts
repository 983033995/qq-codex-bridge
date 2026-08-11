import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  WEIXIN_WORKER_AUTH_ENV,
  WEIXIN_WORKER_PROTOCOL_VERSION,
  WeixinWorkerSupervisor,
  type DaemonToWorkerMessage,
  type WeixinWorkerChild,
  type WeixinWorkerEvent
} from "../../packages/channel-weixin/src/index.js";

describe("vNext Weixin worker supervisor", () => {
  it("uses authenticated negotiation, ping, and increasing crash backoff", async () => {
    const children: FakeChild[] = [];
    const events: WeixinWorkerEvent[] = [];
    const inbound: unknown[] = [];
    const supervisor = new WeixinWorkerSupervisor({
      workerScriptPath: "/fake/weixin-worker.js",
      configuration: () => configuration(["weixin:personal"]),
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 200,
      handshakeTimeoutMs: 100,
      pingTimeoutMs: 100,
      stopTimeoutMs: 100,
      stableUptimeMs: 1_000,
      restartBackoffMs: [1, 5, 20],
      onEvent: (event) => events.push(event),
      onInboundMessage: (message) => { inbound.push(message); },
      spawnWorker(input) {
        const child = new FakeChild(input.env[WEIXIN_WORKER_AUTH_ENV]!);
        children.push(child);
        queueMicrotask(() => child.hello());
        return child;
      }
    });

    await supervisor.start();
    await eventually(async () => (await supervisor.health()).status === "ready");
    await expect(supervisor.ping()).resolves.toBeUndefined();
    await expect(supervisor.loginStatus("weixin:personal")).resolves.toMatchObject({ status: "logged_out" });
    await expect(supervisor.startLogin("weixin:personal")).resolves.toMatchObject({
      status: "awaiting_scan",
      qrCodeContent: "qr-content"
    });
    await expect(supervisor.logout("weixin:personal")).resolves.toMatchObject({ status: "logged_out" });
    children[0]!.inbound();
    await eventually(() => inbound.length === 1);
    expect(inbound).toContainEqual(expect.objectContaining({
      accountId: "weixin:personal",
      providerMessageId: "provider-inbound-1",
      text: "hello",
      attachments: [expect.objectContaining({ id: "attachment-1", kind: "image" })]
    }));
    await expect(supervisor.deliver({
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
    })).resolves.toBe("provider-delivery-1");
    expect(children[0]!.deliveries).toContainEqual(expect.objectContaining({
      deliveryKey: "delivery-1",
      attachments: [expect.objectContaining({ id: "attachment-outbound-1" })]
    }));
    expect(JSON.stringify(events)).not.toContain("qr-content");
    expect(JSON.stringify(events)).not.toContain("hello");

    children[0]!.crash();
    await eventually(() => children.length === 2);
    await eventually(async () => (await supervisor.health()).status === "ready");
    children[1]!.crash();
    await eventually(() => children.length === 3);
    await eventually(async () => (await supervisor.health()).status === "ready");

    expect(events.filter((event) => event.type === "weixin.worker.restart_scheduled").map((event) => event.payload.delayMs))
      .toEqual([1, 5]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "weixin.worker.authenticated" }),
      expect.objectContaining({ type: "weixin.worker.ready" })
    ]));

    await supervisor.stop();
    expect((await supervisor.health()).status).toBe("offline");
  });

  it("rejects an unauthenticated worker without restart looping", async () => {
    let spawnCount = 0;
    const supervisor = new WeixinWorkerSupervisor({
      workerScriptPath: "/fake/weixin-worker.js",
      configuration: () => configuration(["weixin:personal"]),
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 100,
      handshakeTimeoutMs: 50,
      restartBackoffMs: [1],
      spawnWorker() {
        spawnCount += 1;
        const child = new FakeChild("wrong-auth-token-with-at-least-32-bytes");
        queueMicrotask(() => child.hello());
        return child;
      }
    });

    await supervisor.start();
    await eventually(async () => (await supervisor.health()).status === "action_required");
    expect(await supervisor.health()).toMatchObject({ code: "WEIXIN_WORKER_AUTH_FAILED" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(spawnCount).toBe(1);
    await supervisor.stop();
  });

  it("rejects an incompatible protocol version without restart looping", async () => {
    let spawnCount = 0;
    const supervisor = new WeixinWorkerSupervisor({
      workerScriptPath: "/fake/weixin-worker.js",
      configuration: () => configuration(["weixin:personal"]),
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 100,
      handshakeTimeoutMs: 50,
      restartBackoffMs: [1],
      spawnWorker(input) {
        spawnCount += 1;
        const child = new FakeChild(input.env[WEIXIN_WORKER_AUTH_ENV]!);
        queueMicrotask(() => child.hello(WEIXIN_WORKER_PROTOCOL_VERSION + 1));
        return child;
      }
    });

    await supervisor.start();
    await eventually(async () => (await supervisor.health()).status === "action_required");
    expect(await supervisor.health()).toMatchObject({ code: "WEIXIN_WORKER_PROTOCOL_MISMATCH" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(spawnCount).toBe(1);
    await supervisor.stop();
  });

  it("kills and restarts a worker whose heartbeat becomes stale", async () => {
    const children: FakeChild[] = [];
    const events: WeixinWorkerEvent[] = [];
    const supervisor = new WeixinWorkerSupervisor({
      workerScriptPath: "/fake/weixin-worker.js",
      configuration: () => configuration(["weixin:personal"]),
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 30,
      handshakeTimeoutMs: 100,
      restartBackoffMs: [100],
      onEvent: (event) => events.push(event),
      spawnWorker(input) {
        const child = new FakeChild(input.env[WEIXIN_WORKER_AUTH_ENV]!);
        children.push(child);
        queueMicrotask(() => child.hello());
        return child;
      }
    });

    await supervisor.start();
    await eventually(async () => (await supervisor.health()).status === "ready");
    await eventually(() => children[0]!.killed);
    expect(await supervisor.health()).toMatchObject({
      status: "degraded",
      code: "WEIXIN_WORKER_HEARTBEAT_TIMEOUT"
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "weixin.worker.heartbeat_timeout" }));
    await supervisor.stop();
  });

  it("stays ready without spawning when no Weixin account is enabled", async () => {
    const supervisor = new WeixinWorkerSupervisor({
      workerScriptPath: "/fake/weixin-worker.js",
      configuration: () => configuration([]),
      spawnWorker() {
        throw new Error("must not spawn");
      }
    });
    await supervisor.start();
    expect(await supervisor.health()).toMatchObject({ status: "ready", message: expect.stringContaining("disabled") });
    await supervisor.stop();
  });
});

class FakeChild extends EventEmitter implements WeixinWorkerChild {
  static nextPid = 5000;
  readonly pid = FakeChild.nextPid++;
  connected = true;
  killed = false;
  private sequence = 0;
  readonly deliveries: Array<Extract<DaemonToWorkerMessage, { type: "message.deliver" }>["delivery"]> = [];

  constructor(private readonly authToken: string) {
    super();
  }

  hello(protocolVersion: number = WEIXIN_WORKER_PROTOCOL_VERSION): void {
    this.emit("message", {
      type: "hello",
      authToken: this.authToken,
      protocolVersion,
      workerVersion: "0.2.0",
      pid: this.pid
    });
  }

  inbound(): void {
    this.emit("message", {
      type: "message.inbound",
      message: {
        accountId: "weixin:personal",
        providerMessageId: "provider-inbound-1",
        senderId: "peer-1",
        peerId: "peer-1",
        chatType: "c2c",
        sequence: 1,
        receivedAt: new Date().toISOString(),
        text: "hello",
        attachments: [{
          id: "attachment-1",
          kind: "image",
          localPath: "/tmp/image.jpg",
          mimeType: "image/jpeg",
          size: 10,
          name: "image.jpg"
        }]
      }
    });
  }

  send(message: DaemonToWorkerMessage, callback?: (error: Error | null) => void): boolean {
    queueMicrotask(() => {
      callback?.(null);
      if (message.type === "initialize") {
        this.emit("message", {
          type: "ready",
          protocolVersion: WEIXIN_WORKER_PROTOCOL_VERSION,
          workerVersion: "0.2.0",
          startedAt: new Date().toISOString(),
          accounts: message.accounts
        });
        this.emit("message", { type: "heartbeat", sequence: this.sequence++, occurredAt: new Date().toISOString() });
      } else if (message.type === "ping") {
        this.emit("message", { type: "pong", id: message.id, occurredAt: new Date().toISOString() });
      } else if (message.type === "login.status") {
        this.emit("message", { type: "command.result", requestId: message.requestId, ok: true, state: loginState("logged_out") });
      } else if (message.type === "login.start") {
        const state = loginState("awaiting_scan");
        this.emit("message", { type: "login.state", state });
        this.emit("message", { type: "command.result", requestId: message.requestId, ok: true, state });
      } else if (message.type === "login.logout") {
        const state = loginState("logged_out");
        this.emit("message", { type: "login.state", state });
        this.emit("message", { type: "command.result", requestId: message.requestId, ok: true, state });
      } else if (message.type === "message.deliver") {
        this.deliveries.push(structuredClone(message.delivery));
        this.emit("message", {
          type: "delivery.result",
          requestId: message.requestId,
          ok: true,
          providerMessageId: "provider-delivery-1"
        });
      } else {
        this.connected = false;
        this.emit("exit", 0, null);
      }
    });
    return true;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.killed) return false;
    this.killed = true;
    this.connected = false;
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }

  crash(): void {
    this.connected = false;
    this.emit("exit", 1, null);
  }
}

async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function configuration(accounts: string[]) {
  return {
    accounts,
    login: {
      stateFilePath: "/tmp/qqcb-vnext-weixin-login-unit.json",
      baseUrl: "https://ilinkai.weixin.qq.com",
      botType: "3",
      qrFetchTimeoutMs: 10_000,
      qrPollTimeoutMs: 35_000,
      qrTotalTimeoutMs: 480_000
    },
    message: {
      stateFilePath: "/tmp/qqcb-vnext-weixin-message-unit.json",
      longPollTimeoutMs: 35_000,
      apiTimeoutMs: 15_000,
      retryDelayMs: 2_000
    }
  };
}

function loginState(status: "logged_out" | "awaiting_scan") {
  return {
    accountId: "weixin:personal",
    status,
    message: status,
    updatedAt: new Date().toISOString(),
    ...(status === "awaiting_scan"
      ? { qrCodeContent: "qr-content", expiresAt: new Date(Date.now() + 60_000).toISOString() }
      : {})
  };
}
