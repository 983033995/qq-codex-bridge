import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { runWeixinWorker } from "../../apps/weixin-worker/src/index.js";
import {
  WEIXIN_WORKER_AUTH_ENV,
  WEIXIN_WORKER_PROTOCOL_VERSION,
  type WorkerToDaemonMessage
} from "../../packages/channel-weixin/src/index.js";

describe("vNext Weixin worker runtime", () => {
  it("authenticates, negotiates, heartbeats, pings, and shuts down over IPC", async () => {
    const port = new FakeWorkerPort("worker-auth-token-with-at-least-32-bytes");
    const runtime = runWeixinWorker(port, { handshakeTimeoutMs: 1_000 });

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
      accounts: ["weixin:personal"]
    });
    expect(port.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "ready", accounts: ["weixin:personal"] }),
      expect.objectContaining({ type: "heartbeat", sequence: 0 })
    ]));

    const pingId = "00000000-0000-4000-8000-000000000001";
    port.emit("message", { type: "ping", id: pingId, sentAt: new Date().toISOString() });
    expect(port.sent).toContainEqual(expect.objectContaining({ type: "pong", id: pingId }));

    runtime.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(port.sent).toContainEqual(expect.objectContaining({ type: "stopped" }));
    expect(port.connected).toBe(false);
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
