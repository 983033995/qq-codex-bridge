import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQqWebhookServer } from "../../apps/bridge-daemon/src/http-server.js";

describe("qq webhook server", () => {
  const servers: Array<{ close: () => void }> = [];

  afterEach(() => {
    while (servers.length > 0) {
      servers.pop()?.close();
    }
  });

  it("returns 202 before async dispatch finishes", async () => {
    let releaseDispatch!: () => void;
    const dispatchPayload = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseDispatch = resolve;
        })
    );
    const server = createQqWebhookServer({
      webhookPath: "/webhooks/qq",
      ingress: {
        dispatchPayload
      }
    });
    servers.push(server);

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected an address info object");
    }

    const fetchPromise = fetch(`http://127.0.0.1:${address.port}/webhooks/qq`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ t: "PING" })
    });

    const response = await Promise.race([
      fetchPromise,
      new Promise<"timed-out">((resolve) => {
        setTimeout(() => resolve("timed-out"), 50);
      })
    ]);

    expect(response).not.toBe("timed-out");
    expect((response as Response).status).toBe(202);

    releaseDispatch();
    await fetchPromise;
  });

  it("accepts qq event callbacks and dispatches them through the gateway", async () => {
    const dispatchPayload = vi.fn().mockResolvedValue(undefined);
    const server = createQqWebhookServer({
      webhookPath: "/webhooks/qq",
      ingress: {
        dispatchPayload
      }
    });
    servers.push(server);

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected an address info object");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/webhooks/qq`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        t: "C2C_MESSAGE_CREATE",
        d: {
          id: "msg-1",
          content: "hello",
          timestamp: "2026-04-09T11:00:00.000Z",
          author: {
            user_openid: "OPENID123"
          }
        }
      })
    });

    expect(response.status).toBe(202);
    expect(dispatchPayload).toHaveBeenCalledWith({
      t: "C2C_MESSAGE_CREATE",
      d: {
        id: "msg-1",
        content: "hello",
        timestamp: "2026-04-09T11:00:00.000Z",
        author: {
          user_openid: "OPENID123"
        }
      }
    });
  });

  it("rejects requests sent to other paths", async () => {
    const dispatchPayload = vi.fn().mockResolvedValue(undefined);
    const server = createQqWebhookServer({
      webhookPath: "/webhooks/qq",
      ingress: {
        dispatchPayload
      }
    });
    servers.push(server);

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected an address info object");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/not-found`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: "{}"
    });

    expect(response.status).toBe(404);
    expect(dispatchPayload).not.toHaveBeenCalled();
  });

  it("rejects malformed json payloads", async () => {
    const dispatchPayload = vi.fn().mockResolvedValue(undefined);
    const server = createQqWebhookServer({
      webhookPath: "/webhooks/qq",
      ingress: {
        dispatchPayload
      }
    });
    servers.push(server);

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected an address info object");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/webhooks/qq`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: "{bad json"
    });

    expect(response.status).toBe(400);
    expect(dispatchPayload).not.toHaveBeenCalled();
  });

  it("reports async dispatch failures through the error hook without changing the accepted response", async () => {
    const onDispatchError = vi.fn();
    const server = createQqWebhookServer({
      webhookPath: "/webhooks/qq",
      ingress: {
        dispatchPayload: vi.fn().mockRejectedValue(new Error("dispatch failed"))
      },
      onDispatchError
    });
    servers.push(server);

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected an address info object");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/webhooks/qq`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ t: "PING" })
    });

    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(onDispatchError).toHaveBeenCalledWith(expect.any(Error), { t: "PING" });
    });
  });
});
