import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { QqGatewayClient } from "../../packages/adapters/qq/src/qq-gateway-client.js";

describe("qq gateway client", () => {
  const servers: Array<{ close: () => void }> = [];

  afterEach(() => {
    while (servers.length > 0) {
      servers.pop()?.close();
    }
  });

  it("identifies on hello and starts heartbeats for a fresh session", async () => {
    let port = 0;
    let sawIdentify = false;
    let sawHeartbeat = false;

    const httpServer = createServer();
    const wsServer = new WebSocketServer({
      server: httpServer,
      path: "/gateway"
    });
    servers.push(wsServer);
    servers.push(httpServer);

    const identifySeen = new Promise<void>((resolve) => {
      wsServer.on("connection", (socket) => {
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 20 } }));
        socket.on("message", (payload) => {
          const message = JSON.parse(payload.toString()) as {
            op: number;
            d?: Record<string, unknown>;
          };

          if (message.op === 2) {
            sawIdentify = true;
            socket.send(JSON.stringify({ op: 0, t: "READY", s: 1, d: { session_id: "session-1" } }));
          }

          if (message.op === 1) {
            sawHeartbeat = true;
            resolve();
          }
        });
      });
    });

    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const address = httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("expected an address info object");
    }
    port = address.port;

    const client = new QqGatewayClient({
      accountKey: "qqbot:default",
      appId: "app-id",
      apiClient: {
        getAccessToken: vi.fn().mockResolvedValue("token-1"),
        getGatewayUrl: vi.fn().mockResolvedValue(`ws://127.0.0.1:${port}/gateway`)
      },
      sessionStore: {
        load: vi.fn().mockReturnValue(null),
        save: vi.fn(),
        clear: vi.fn()
      },
      reconnectDelaysMs: [5]
    });

    await client.onMessage(async () => undefined);
    await client.start();
    await identifySeen;

    expect(sawIdentify).toBe(true);
    expect(sawHeartbeat).toBe(true);
    await client.stop();
  });

  it("resumes an existing session when a saved session is available", async () => {
    let port = 0;
    let resumePayload: Record<string, unknown> | null = null;

    const httpServer = createServer();
    const wsServer = new WebSocketServer({
      server: httpServer,
      path: "/gateway"
    });
    servers.push(wsServer);
    servers.push(httpServer);

    const resumeSeen = new Promise<void>((resolve) => {
      wsServer.on("connection", (socket) => {
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
        socket.on("message", (payload) => {
          const message = JSON.parse(payload.toString()) as {
            op: number;
            d?: Record<string, unknown>;
          };

          if (message.op === 6) {
            resumePayload = message.d ?? null;
            socket.send(JSON.stringify({ op: 0, t: "RESUMED", s: 42, d: {} }));
            resolve();
          }
        });
      });
    });

    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const address = httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("expected an address info object");
    }
    port = address.port;

    const client = new QqGatewayClient({
      accountKey: "qqbot:default",
      appId: "app-id",
      apiClient: {
        getAccessToken: vi.fn().mockResolvedValue("token-1"),
        getGatewayUrl: vi.fn().mockResolvedValue(`ws://127.0.0.1:${port}/gateway`)
      },
      sessionStore: {
        load: vi.fn().mockReturnValue({
          sessionId: "session-previous",
          lastSeq: 41
        }),
        save: vi.fn(),
        clear: vi.fn()
      },
      reconnectDelaysMs: [5]
    });

    await client.onMessage(async () => undefined);
    await client.start();
    await resumeSeen;

    expect(resumePayload).toEqual({
      token: "QQBot token-1",
      session_id: "session-previous",
      seq: 41
    });
    await client.stop();
  });

  it("dispatches c2c gateway events through the existing qq normalizer", async () => {
    let port = 0;
    const handler = vi.fn().mockResolvedValue(undefined);

    const httpServer = createServer();
    const wsServer = new WebSocketServer({
      server: httpServer,
      path: "/gateway"
    });
    servers.push(wsServer);
    servers.push(httpServer);

    const messageDelivered = new Promise<void>((resolve) => {
      wsServer.on("connection", (socket) => {
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
        socket.on("message", (payload) => {
          const message = JSON.parse(payload.toString()) as {
            op: number;
          };

          if (message.op === 2) {
            socket.send(JSON.stringify({ op: 0, t: "READY", s: 1, d: { session_id: "session-1" } }));
            socket.send(
              JSON.stringify({
                op: 0,
                t: "C2C_MESSAGE_CREATE",
                s: 2,
                d: {
                  id: "msg-1",
                  content: "hello from gateway",
                  timestamp: "2026-04-09T12:50:00.000Z",
                  author: {
                    user_openid: "OPENID123"
                  }
                }
              })
            );
            resolve();
          }
        });
      });
    });

    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const address = httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("expected an address info object");
    }
    port = address.port;

    const client = new QqGatewayClient({
      accountKey: "qqbot:default",
      appId: "app-id",
      apiClient: {
        getAccessToken: vi.fn().mockResolvedValue("token-1"),
        getGatewayUrl: vi.fn().mockResolvedValue(`ws://127.0.0.1:${port}/gateway`)
      },
      sessionStore: {
        load: vi.fn().mockReturnValue(null),
        save: vi.fn(),
        clear: vi.fn()
      },
      reconnectDelaysMs: [5]
    });

    await client.onMessage(handler);
    await client.start();
    await messageDelivered;

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledWith({
        messageId: "msg-1",
        accountKey: "qqbot:default",
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        peerKey: "qq:c2c:OPENID123",
        chatType: "c2c",
        senderId: "OPENID123",
        text: "hello from gateway",
        receivedAt: "2026-04-09T12:50:00.000Z"
      });
    });
    await client.stop();
  });
});
