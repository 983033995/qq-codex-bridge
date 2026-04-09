import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { CdpSession } from "../../packages/adapters/codex-desktop/src/cdp-session.js";

describe("cdp session", () => {
  const servers: Array<{ close: () => void }> = [];

  afterEach(() => {
    while (servers.length > 0) {
      servers.pop()?.close();
    }
  });

  it("discovers and caches the browser websocket endpoint", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          Browser: "Codex/1.0",
          webSocketDebuggerUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );

    const session = new CdpSession(
      {
        appName: "Codex",
        remoteDebuggingPort: 9229
      },
      { fetchFn }
    );

    await expect(session.connect()).resolves.toEqual({
      appName: "Codex",
      browserVersion: "Codex/1.0",
      browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
    });
    await expect(session.connect()).resolves.toEqual({
      appName: "Codex",
      browserVersion: "Codex/1.0",
      browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
    });
    expect(session.getBrowserWebSocketUrl()).toBe(
      "ws://127.0.0.1:9229/devtools/browser/abc"
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith("http://127.0.0.1:9229/json/version");
  });

  it("lists inspectable page targets from the cdp endpoint", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/json/list")) {
        return new Response(
          JSON.stringify([
            {
              id: "page-1",
              title: "Codex",
              type: "page",
              url: "app://codex"
            }
          ]),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      return new Response(
        JSON.stringify({
          Browser: "Codex/1.0",
          webSocketDebuggerUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    });

    const session = new CdpSession(
      {
        appName: "Codex",
        remoteDebuggingPort: 9229
      },
      { fetchFn }
    );

    await expect(session.listTargets()).resolves.toEqual([
      {
        id: "page-1",
        title: "Codex",
        type: "page",
        url: "app://codex"
      }
    ]);
    expect(fetchFn).toHaveBeenCalledWith("http://127.0.0.1:9229/json/list");
  });

  it("attaches to a page target and evaluates javascript through the browser websocket", async () => {
    let port = 0;
    let attachCount = 0;
    const httpServer = createServer((request, response) => {
      if (request.url === "/json/version") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            Browser: "Codex/1.0",
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/abc`
          })
        );
        return;
      }

      if (request.url === "/json/list") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify([
            {
              id: "page-1",
              title: "Codex",
              type: "page",
              url: "app://codex"
            }
          ])
        );
        return;
      }

      response.writeHead(404);
      response.end();
    });
    const browserSocketServer = new WebSocketServer({
      server: httpServer,
      path: "/devtools/browser/abc"
    });
    servers.push(browserSocketServer);
    servers.push(httpServer);

    browserSocketServer.on("connection", (socket) => {
      socket.on("message", (payload) => {
        const message = JSON.parse(payload.toString()) as {
          id: number;
          method: string;
          params?: Record<string, unknown>;
          sessionId?: string;
        };

        if (message.method === "Target.attachToTarget") {
          attachCount += 1;
          socket.send(
            JSON.stringify({
              id: message.id,
              result: {
                sessionId: "session-1"
              }
            })
          );
          return;
        }

        if (message.method === "Runtime.evaluate") {
          expect(message.sessionId).toBe("session-1");
          expect(message.params?.expression).toBe("document.body.innerText");
          socket.send(
            JSON.stringify({
              id: message.id,
              result: {
                result: {
                  type: "string",
                  value: "Assistant: live reply"
                }
              }
            })
          );
        }
      });
    });

    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const address = httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("expected an address info object");
    }
    port = address.port;

    const session = new CdpSession({
      appName: "Codex",
      remoteDebuggingPort: port
    });

    await expect(session.evaluateOnPage("document.body.innerText")).resolves.toBe(
      "Assistant: live reply"
    );
    await expect(session.evaluateOnPage("document.body.innerText")).resolves.toBe(
      "Assistant: live reply"
    );
    expect(attachCount).toBe(1);
  });
});
