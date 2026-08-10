import { request as httpRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  ControlApiServer,
  isLoopbackAddress,
  isLoopbackHost,
  type ControlApiInvocation,
  type ControlApiServices
} from "../../apps/control-daemon/src/index.js";
import { createDefaultConfig } from "../../packages/config/src/index.js";
import { VNextDomainError } from "../../packages/domain/src/vnext/index.js";

describe("vNext control API contract", () => {
  it("maps every required API operation through authenticated, validated HTTP routes", async () => {
    const invocations: ControlApiInvocation[] = [];
    const { server, baseUrl, auth } = await startServer({
      async execute(invocation) {
        invocations.push(invocation);
        return { operation: invocation.operation };
      }
    });
    const config = createDefaultConfig();
    const cases: Array<{
      method: string;
      path: string;
      operation: ControlApiInvocation["operation"];
      body?: unknown;
    }> = [
      { method: "GET", path: "/health", operation: "health.get" },
      { method: "GET", path: "/system/status", operation: "system.status" },
      { method: "GET", path: "/channels", operation: "channels.list" },
      { method: "POST", path: "/channels", operation: "channels.create", body: { channel: "weixin", accountId: "main", enabled: true } },
      { method: "POST", path: "/channels/weixin%3Amain/test", operation: "channels.test", body: {} },
      { method: "POST", path: "/channels/weixin%3Amain/restart", operation: "channels.restart", body: {} },
      { method: "DELETE", path: "/channels/weixin%3Amain", operation: "channels.delete" },
      { method: "GET", path: "/spaces?limit=25&cursor=next", operation: "spaces.list" },
      { method: "GET", path: "/spaces/space-1", operation: "spaces.get" },
      { method: "GET", path: "/spaces/space-1/messages?limit=10", operation: "spaces.messages.list" },
      { method: "POST", path: "/spaces/space-1/bindings", operation: "spaces.bindings.create", body: { threadId: "thread-1", mode: "shared", replaceActive: true } },
      { method: "DELETE", path: "/spaces/space-1/bindings/current", operation: "spaces.bindings.deleteCurrent" },
      { method: "GET", path: "/threads?limit=20", operation: "threads.list" },
      { method: "POST", path: "/threads", operation: "threads.create", body: { title: "New thread", cwd: "/tmp/project" } },
      { method: "PATCH", path: "/threads/thread-1", operation: "threads.update", body: { title: "Renamed" } },
      { method: "GET", path: "/turns?limit=20", operation: "turns.list" },
      { method: "POST", path: "/turns/turn-1/interrupt", operation: "turns.interrupt", body: {} },
      { method: "GET", path: "/router/config", operation: "router.config.get" },
      { method: "PUT", path: "/router/config", operation: "router.config.update", body: config.router },
      { method: "POST", path: "/router/test", operation: "router.test", body: { text: "新建线程", spaceId: "space-1" } },
      { method: "GET", path: "/router/decisions?limit=10", operation: "router.decisions.list" },
      { method: "GET", path: "/config", operation: "config.get" },
      { method: "POST", path: "/config/plan", operation: "config.plan", body: { candidate: config } },
      { method: "POST", path: "/config/apply", operation: "config.apply", body: { candidate: config, secretChanges: [] } },
      { method: "GET", path: "/diagnostics/events?limit=10", operation: "diagnostics.events.list" },
      { method: "POST", path: "/diagnostics/export", operation: "diagnostics.export", body: { includeLogs: false } },
      { method: "GET", path: "/push-targets", operation: "pushTargets.list" },
      { method: "POST", path: "/push-targets", operation: "pushTargets.create", body: { alias: "alerts", spaceId: "space-1", enabled: true } },
      { method: "DELETE", path: "/push-targets/alerts", operation: "pushTargets.delete" }
    ];

    try {
      for (const testCase of cases) {
        const response = await apiFetch(baseUrl, testCase.path, auth, {
          method: testCase.method,
          ...(testCase.body === undefined ? {} : { body: JSON.stringify(testCase.body) })
        });
        expect(response.status, `${testCase.method} ${testCase.path}`).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          data: { operation: testCase.operation }
        });
      }
      expect(invocations.map((invocation) => invocation.operation)).toEqual(
        cases.map((testCase) => testCase.operation)
      );
      expect(invocations.find((item) => item.operation === "channels.test")?.params)
        .toEqual({ id: "weixin:main" });
      expect(invocations.find((item) => item.operation === "spaces.list")?.query)
        .toEqual({ limit: 25, cursor: "next" });
    } finally {
      await server.stop();
    }
  });

  it("requires local sessions and CSRF, validates bodies, and returns stable method errors", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const { server, baseUrl, auth } = await startServer({ execute });
    try {
      const unauthorized = await fetch(`${baseUrl}/api/v1/health`);
      expect(unauthorized.status).toBe(401);
      await expect(unauthorized.json()).resolves.toMatchObject({
        error: { code: "SESSION_REQUIRED" }
      });

      const csrfFailure = await fetch(`${baseUrl}/api/v1/channels`, {
        method: "POST",
        headers: { Cookie: auth.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "weixin", accountId: "main", enabled: true })
      });
      expect(csrfFailure.status).toBe(403);
      await expect(csrfFailure.json()).resolves.toMatchObject({ error: { code: "CSRF_INVALID" } });

      const invalid = await apiFetch(baseUrl, "/channels", auth, {
        method: "POST",
        body: JSON.stringify({ channel: "weixin", enabled: true })
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toMatchObject({
        error: { code: "VALIDATION_ERROR", message: "Request validation failed" }
      });

      const invalidMediaType = await apiFetch(baseUrl, "/channels", auth, {
        method: "POST",
        headers: { "Content-Type": "application/jsonp" },
        body: JSON.stringify({ channel: "weixin", accountId: "main", enabled: true })
      });
      expect(invalidMediaType.status).toBe(415);
      await expect(invalidMediaType.json()).resolves.toMatchObject({
        error: { code: "UNSUPPORTED_MEDIA_TYPE" }
      });

      const wrongMethod = await apiFetch(baseUrl, "/health", auth, { method: "POST", body: "{}" });
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.headers.get("allow")).toBe("GET");

      const outsidePrefix = await fetch(`${baseUrl}/health`, {
        headers: { Cookie: auth.cookie }
      });
      expect(outsidePrefix.status).toBe(404);
      await expect(outsidePrefix.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });

      const malformedPath = await apiFetch(baseUrl, "/channels/%E0%A4%A/test", auth, {
        method: "POST",
        body: "{}"
      });
      expect(malformedPath.status).toBe(400);
      await expect(malformedPath.json()).resolves.toMatchObject({
        error: { code: "INVALID_PATH_ENCODING" }
      });
    } finally {
      await server.stop();
    }
  });

  it("applies complete Router invariants to standalone Router updates", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const { server, baseUrl, auth } = await startServer({ execute });
    const router = createDefaultConfig().router;
    try {
      const missingEnabledFields = await apiFetch(baseUrl, "/router/config", auth, {
        method: "PUT",
        body: JSON.stringify({ ...router, mode: "assist" })
      });
      expect(missingEnabledFields.status).toBe(400);
      const missingBody = await missingEnabledFields.json() as {
        error: { code: string; details: Array<{ path: string }> };
      };
      expect(missingBody.error.code).toBe("VALIDATION_ERROR");
      expect(missingBody.error.details.map((detail) => detail.path)).toEqual([
        "baseUrl",
        "model",
        "secretRef"
      ]);

      const unsafeUrl = await apiFetch(baseUrl, "/router/config", auth, {
        method: "PUT",
        body: JSON.stringify({ ...router, baseUrl: "http://router.example.com/v1" })
      });
      expect(unsafeUrl.status).toBe(400);
      await expect(unsafeUrl.json()).resolves.toMatchObject({
        error: {
          code: "VALIDATION_ERROR",
          details: [{ path: "baseUrl" }]
        }
      });

      expect(execute).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it("maps domain errors and redacts unexpected internal failures", async () => {
    let mode: "domain" | "internal" = "domain";
    const { server, baseUrl, auth } = await startServer({
      async execute() {
        if (mode === "domain") {
          throw new VNextDomainError("BINDING_CONFLICT", "binding already active", { bindingId: "binding-1" });
        }
        throw new Error("secret-token-must-not-leak");
      }
    });
    try {
      const domain = await apiFetch(baseUrl, "/spaces/space-1", auth);
      expect(domain.status).toBe(409);
      await expect(domain.json()).resolves.toMatchObject({
        error: { code: "BINDING_CONFLICT", details: { bindingId: "binding-1" } }
      });

      mode = "internal";
      const internal = await apiFetch(baseUrl, "/health", auth);
      expect(internal.status).toBe(500);
      const text = await internal.text();
      expect(text).toContain("INTERNAL_ERROR");
      expect(text).not.toContain("secret-token-must-not-leak");
    } finally {
      await server.stop();
    }
  });

  it("only accepts loopback bind, remote, and Host values", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.22.4.8")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(() => new ControlApiServer({
      host: "0.0.0.0",
      port: 3100,
      services: { execute: async () => undefined }
    })).toThrow("loopback");
  });

  it("expires local sessions and rejects non-loopback Host headers", async () => {
    let now = Date.parse("2026-08-10T12:00:00.000Z");
    const tokens = ["session-token-abcdefghijklmnopqrstuvwxyz", "csrf-token-abcdefghijklmnopqrstuvwxyz"];
    const server = new ControlApiServer({
      host: "127.0.0.1",
      port: 0,
      services: { execute: async () => ({ ok: true }) },
      sessionTtlMs: 1_000,
      now: () => now,
      randomToken: () => tokens.shift() ?? "fallback-token-abcdefghijklmnopqrstuvwxyz"
    });
    await server.start();
    const address = server.address();
    if (!address) {
      throw new Error("test API server did not expose an address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const sessionResponse = await fetch(`${baseUrl}/api/v1/session`);
      const cookie = sessionResponse.headers.get("set-cookie")!.split(";", 1)[0]!;

      const nonLoopbackHost = await requestJson({
        port: address.port,
        path: "/api/v1/health",
        headers: { Cookie: cookie, Host: "example.com" }
      });
      expect(nonLoopbackHost.status).toBe(403);
      expect(nonLoopbackHost.body).toMatchObject({
        error: { code: "LOOPBACK_REQUIRED" }
      });

      now += 1_000;
      const expired = await fetch(`${baseUrl}/api/v1/health`, { headers: { Cookie: cookie } });
      expect(expired.status).toBe(401);
      await expect(expired.json()).resolves.toMatchObject({
        error: { code: "SESSION_REQUIRED" }
      });
    } finally {
      await server.stop();
    }
  });
});

async function startServer(services: ControlApiServices): Promise<{
  server: ControlApiServer;
  baseUrl: string;
  auth: { cookie: string; csrfToken: string };
}> {
  const tokens = ["session-token-abcdefghijklmnopqrstuvwxyz", "csrf-token-abcdefghijklmnopqrstuvwxyz"];
  const server = new ControlApiServer({
    host: "127.0.0.1",
    port: 0,
    services,
    randomToken: () => tokens.shift() ?? "fallback-token-abcdefghijklmnopqrstuvwxyz"
  });
  await server.start();
  const address = server.address();
  if (!address) {
    throw new Error("test API server did not expose an address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const sessionResponse = await fetch(`${baseUrl}/api/v1/session`);
  const session = await sessionResponse.json() as { data: { csrfToken: string } };
  return {
    server,
    baseUrl,
    auth: {
      cookie: sessionResponse.headers.get("set-cookie")!.split(";", 1)[0]!,
      csrfToken: session.data.csrfToken
    }
  };
}

function apiFetch(
  baseUrl: string,
  path: string,
  auth: { cookie: string; csrfToken: string },
  init: RequestInit = {}
): Promise<Response> {
  const method = init.method ?? "GET";
  return fetch(`${baseUrl}${path.startsWith("/api/v1") ? path : `/api/v1${path}`}`, {
    ...init,
    headers: {
      Cookie: auth.cookie,
      ...(method === "GET" ? {} : { "X-CSRF-Token": auth.csrfToken }),
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init.headers
    }
  });
}

function requestJson(options: {
  port: number;
  path: string;
  headers: Record<string, string>;
}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: options.port,
      path: options.path,
      headers: options.headers
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once("error", reject);
    request.end();
  });
}
