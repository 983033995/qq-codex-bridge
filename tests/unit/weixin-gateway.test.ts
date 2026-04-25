import { describe, expect, it, vi } from "vitest";
import { createWeixinGatewayServer } from "../../apps/weixin-gateway/src/server.js";
import type { WeixinGatewayOutboundMessage } from "../../apps/weixin-gateway/src/message-store.js";

function createGatewayConfig() {
  return {
    listenHost: "127.0.0.1",
    listenPort: 3200,
    bridgeBaseUrl: "http://127.0.0.1:3100",
    bridgeWebhookPath: "/webhooks/weixin",
    expectedBearerToken: "token",
    messageStorePath: "runtime/test.ndjson",
    recentMessageLimit: 20,
    enabled: true,
    accountId: "default",
    baseUrl: "https://ilinkai.weixin.qq.com",
    token: "bot-token",
    longPollTimeoutMs: 35_000,
    apiTimeoutMs: 15_000,
    stateFilePath: "runtime/weixin-gateway-state.json",
    loginBaseUrl: "https://ilinkai.weixin.qq.com",
    loginBotType: "3",
    qrFetchTimeoutMs: 10_000,
    qrPollTimeoutMs: 35_000,
    qrTotalTimeoutMs: 480_000,
    stateWatchIntervalMs: 1_000
  };
}

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
      config: createGatewayConfig(),
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

  it("stores outbound bridge messages, sends them to weixin, and exposes them via recent list", async () => {
    const items: WeixinGatewayOutboundMessage[] = [];
    const store = {
      append(message: WeixinGatewayOutboundMessage) {
        items.push(message);
      },
      listRecent() {
        return [...items].reverse();
      }
    };
    const outboundSender = {
      sendTextMessage: vi.fn().mockResolvedValue(undefined)
    };
    const server = createWeixinGatewayServer({
      config: createGatewayConfig(),
      messageStore: store,
      fetchFn: vi.fn(),
      outboundSender
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
    expect(outboundSender.sendTextMessage).toHaveBeenCalledWith({
      peerId: "wxid_peer",
      chatType: "c2c",
      text: "bridge reply",
      replyToMessageId: undefined
    });

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

  it("dedupes repeated outbound bridge messages and only sends them once", async () => {
    const items: WeixinGatewayOutboundMessage[] = [];
    const store = {
      append(message: WeixinGatewayOutboundMessage) {
        items.push(message);
      },
      listRecent() {
        return [...items].reverse();
      }
    };
    const outboundSender = {
      sendTextMessage: vi.fn().mockResolvedValue(undefined)
    };
    const server = createWeixinGatewayServer({
      config: createGatewayConfig(),
      messageStore: store,
      fetchFn: vi.fn(),
      outboundSender
    });

    const sendRequest = () =>
      new Promise<{ statusCode: number; body?: string }>((resolve) => {
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
                  content: "bridge reply",
                  replyToMessageId: "wx-msg-1"
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

    const firstResponse = await sendRequest();
    const secondResponse = await sendRequest();

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(items).toHaveLength(1);
    expect(outboundSender.sendTextMessage).toHaveBeenCalledTimes(1);

    const firstBody = JSON.parse(firstResponse.body ?? "{}") as { id?: string };
    const secondBody = JSON.parse(secondResponse.body ?? "{}") as { id?: string; deduped?: boolean };
    expect(secondBody).toEqual({
      id: firstBody.id,
      deduped: true
    });
  });

  it("accepts outbound media payloads and forwards them to the active client", async () => {
    const items: WeixinGatewayOutboundMessage[] = [];
    const store = {
      append(message: WeixinGatewayOutboundMessage) {
        items.push(message);
      },
      listRecent() {
        return [...items].reverse();
      }
    };
    const outboundSender = {
      sendTextMessage: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined)
    };
    const server = createWeixinGatewayServer({
      config: createGatewayConfig(),
      messageStore: store,
      fetchFn: vi.fn(),
      outboundSender
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
                mediaArtifacts: [
                  {
                    kind: "image",
                    sourceUrl: "/tmp/demo.jpg",
                    localPath: "/tmp/demo.jpg",
                    mimeType: "image/jpeg",
                    fileSize: 2048,
                    originalName: "demo.jpg"
                  }
                ]
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
    expect(outboundSender.sendMessage).toHaveBeenCalledWith({
      peerId: "wxid_peer",
      chatType: "c2c",
      content: undefined,
      mediaArtifacts: [
        expect.objectContaining({
          kind: "image",
          localPath: "/tmp/demo.jpg"
        })
      ],
      replyToMessageId: undefined
    });
    expect(outboundSender.sendTextMessage).not.toHaveBeenCalled();
  });
});
