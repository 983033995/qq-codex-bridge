import { describe, expect, it, vi } from "vitest";
import { createWeixinGatewayServer } from "../../apps/weixin-gateway/src/server.js";
import type { WeixinGatewayOutboundMessage } from "../../apps/weixin-gateway/src/message-store.js";

describe("weixin gateway server", () => {
  it("forwards inbound text payloads to bridge webhook", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => ""
    });
    const store = {
      append: vi.fn(),
      listRecent: vi.fn().mockReturnValue([])
    };
    const server = createWeixinGatewayServer({
      config: {
        listenHost: "127.0.0.1",
        listenPort: 3200,
        bridgeBaseUrl: "http://127.0.0.1:3100",
        bridgeWebhookPath: "/webhooks/weixin",
        expectedBearerToken: "token",
        messageStorePath: "runtime/test.ndjson",
        recentMessageLimit: 20
      },
      messageStore: store,
      fetchFn
    });

    const response = await new Promise<{ statusCode: number; body?: string }>((resolve) => {
      server.emit(
        "request",
        {
          method: "POST",
          url: "/inbound/text",
          headers: {},
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from(
              JSON.stringify({
                senderId: "wxid_sender",
                messageId: "msg-1",
                text: "hello"
              })
            );
          }
        } as never,
        {
          statusCode: 200,
          headers: {} as Record<string, string>,
          setHeader(name: string, value: string) {
            this.headers[name] = value;
          },
          end(body?: string) {
            resolve({ statusCode: this.statusCode, body });
          }
        }
      );
    });

    expect(response.statusCode).toBe(202);
    expect(fetchFn).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/webhooks/weixin",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" }
      })
    );
    expect(store.append).not.toHaveBeenCalled();
  });

  it("stores outbound bridge messages and exposes them via recent list", async () => {
    const items: WeixinGatewayOutboundMessage[] = [];
    const store = {
      append(message: WeixinGatewayOutboundMessage) {
        items.push(message);
      },
      listRecent() {
        return [...items].reverse();
      }
    };
    const server = createWeixinGatewayServer({
      config: {
        listenHost: "127.0.0.1",
        listenPort: 3200,
        bridgeBaseUrl: "http://127.0.0.1:3100",
        bridgeWebhookPath: "/webhooks/weixin",
        expectedBearerToken: "token",
        messageStorePath: "runtime/test.ndjson",
        recentMessageLimit: 20
      },
      messageStore: store,
      fetchFn: vi.fn()
    });

    const postResponse = await new Promise<{ statusCode: number; body?: string }>((resolve) => {
      server.emit(
        "request",
        {
          method: "POST",
          url: "/messages",
          headers: {
            authorization: "Bearer token"
          },
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from(
              JSON.stringify({
                peerId: "wxid_peer",
                chatType: "c2c",
                content: "bridge reply"
              })
            );
          }
        } as never,
        {
          statusCode: 200,
          headers: {} as Record<string, string>,
          setHeader(name: string, value: string) {
            this.headers[name] = value;
          },
          end(body?: string) {
            resolve({ statusCode: this.statusCode, body });
          }
        }
      );
    });

    expect(postResponse.statusCode).toBe(200);
    expect(items).toHaveLength(1);
    expect(items[0]?.content).toBe("bridge reply");

    const getResponse = await new Promise<{ statusCode: number; body?: string }>((resolve) => {
      server.emit(
        "request",
        {
          method: "GET",
          url: "/messages",
          headers: {}
        } as never,
        {
          statusCode: 200,
          headers: {} as Record<string, string>,
          setHeader(name: string, value: string) {
            this.headers[name] = value;
          },
          end(body?: string) {
            resolve({ statusCode: this.statusCode, body });
          }
        }
      );
    });

    expect(getResponse.statusCode).toBe(200);
    expect(JSON.parse(getResponse.body ?? "{}")).toEqual({
      items: [items[0]]
    });
  });
});
