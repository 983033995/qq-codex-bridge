import { describe, expect, it, vi } from "vitest";
import {
  ControlApiClient,
  ControlApiError
} from "../../apps/control-ui/src/api-client.js";

describe("vNext control UI API client", () => {
  it("deduplicates Session acquisition and attaches CSRF to mutations", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/session")) {
        return jsonResponse(200, {
          data: {
            csrfToken: "csrf-token",
            expiresAt: "2099-08-10T12:00:00.000Z"
          },
          requestId: "request-session"
        });
      }
      return jsonResponse(200, {
        data: { path: url, method: init?.method },
        requestId: "request-operation"
      });
    });
    const client = new ControlApiClient("/api/v1", fetchFn);

    const [created, status] = await Promise.all([
      client.post<{ method: string }>("/channels", { channel: "weixin" }),
      client.get<{ method: string }>("/health")
    ]);

    expect(created.method).toBe("POST");
    expect(status.method).toBe("GET");
    expect(fetchFn.mock.calls.filter(([input]) => String(input).endsWith("/session"))).toHaveLength(1);
    const mutation = fetchFn.mock.calls.find(([input]) => String(input).endsWith("/channels"));
    expect(mutation?.[1]).toMatchObject({
      credentials: "same-origin",
      headers: expect.objectContaining({
        "Content-Type": "application/json",
        "X-CSRF-Token": "csrf-token"
      })
    });
  });

  it("maps stable API failures without losing request correlation", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/session")) {
        return jsonResponse(200, {
          data: { csrfToken: "csrf-token", expiresAt: "2099-08-10T12:00:00.000Z" },
          requestId: "request-session"
        });
      }
      return jsonResponse(409, {
        error: {
          code: "BINDING_CONFLICT",
          message: "binding already active",
          details: { bindingId: "binding-1" }
        },
        requestId: "request-conflict"
      });
    });
    const client = new ControlApiClient("/api/v1", fetchFn);

    await expect(client.post("/spaces/space-1/bindings", { threadId: "thread-1" }))
      .rejects.toEqual(expect.objectContaining({
        status: 409,
        code: "BINDING_CONFLICT",
        requestId: "request-conflict",
        details: { bindingId: "binding-1" }
      } satisfies Partial<ControlApiError>));
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
