import { describe, expect, it, vi } from "vitest";
import { CdpSession } from "../../packages/adapters/codex-desktop/src/cdp-session.js";

describe("cdp session", () => {
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
});
