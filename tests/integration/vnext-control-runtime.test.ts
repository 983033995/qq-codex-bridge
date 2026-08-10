import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProductionControlDaemon } from "../../apps/control-daemon/src/index.js";
import {
  AtomicConfigStore,
  calculateConfigRevision,
  createDefaultConfig
} from "../../packages/config/src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("vNext production control runtime", () => {
  it("serves the UI and real system state through the composed API", async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "qqcb-vnext-runtime-"));
    temporaryDirectories.push(dataDirectory);
    const staticRoot = path.join(dataDirectory, "ui");
    await mkdir(staticRoot);
    await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><p>vnext-control-ui</p>\n");
    const config = createDefaultConfig();
    config.runtime.listenPort = await freePort();
    await new AtomicConfigStore(path.join(dataDirectory, "config.json")).writeAtomic({
      value: config,
      revision: calculateConfigRevision(config)
    });
    const runtime = await createProductionControlDaemon({ dataDirectory, staticRoot });
    try {
      await runtime.start();
      const entry = await fetch(`${runtime.baseUrl}/`);
      expect(entry.status).toBe(200);
      await expect(entry.text()).resolves.toContain("vnext-control-ui");

      const sessionResponse = await fetch(`${runtime.baseUrl}/api/v1/session`);
      const cookie = sessionResponse.headers.get("set-cookie")!.split(";", 1)[0]!;
      const statusResponse = await fetch(`${runtime.baseUrl}/api/v1/system/status`, {
        headers: { Cookie: cookie }
      });
      expect(statusResponse.status).toBe(200);
      await expect(statusResponse.json()).resolves.toMatchObject({
        data: {
          state: "running",
          activeRevision: calculateConfigRevision(config),
          version: "0.2.0"
        }
      });

      const healthResponse = await fetch(`${runtime.baseUrl}/api/v1/health`, {
        headers: { Cookie: cookie }
      });
      expect(healthResponse.status).toBe(200);
      const health = await healthResponse.json() as {
        data: { components: Array<{ component: string; code?: string }> };
      };
      expect(health.data.components).toEqual(expect.arrayContaining([
        expect.objectContaining({ component: "codex" }),
        expect.objectContaining({ component: "management-api" })
      ]));
      expect(health.data.components).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "HEALTH_CHECK_FAILED" })
      ]));

      const eventsResponse = await fetch(`${runtime.baseUrl}/api/v1/diagnostics/events?limit=20`, {
        headers: { Cookie: cookie }
      });
      expect(eventsResponse.status).toBe(200);
      await expect(eventsResponse.json()).resolves.toMatchObject({
        data: { items: expect.arrayContaining([expect.objectContaining({ type: "component.started" })]) }
      });
    } finally {
      await runtime.stop();
    }
  });

  it("starts and exposes the supervised Weixin worker after the first account is configured", async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "qqcb-vnext-weixin-runtime-"));
    temporaryDirectories.push(dataDirectory);
    const staticRoot = path.join(dataDirectory, "ui");
    await mkdir(staticRoot);
    await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><p>vnext-control-ui</p>\n");
    const config = createDefaultConfig();
    config.runtime.listenPort = await freePort();
    await new AtomicConfigStore(path.join(dataDirectory, "config.json")).writeAtomic({
      value: config,
      revision: calculateConfigRevision(config)
    });
    const fakeLogin = await startFakeWeixinLoginServer();
    const runtime = await createProductionControlDaemon({
      dataDirectory,
      staticRoot,
      weixinWorkerScriptPath: path.resolve("apps/weixin-worker/src/cli.ts"),
      weixinWorkerExecArgv: ["--import", "tsx"],
      weixinLoginBaseUrl: fakeLogin.baseUrl,
      weixinQrPollTimeoutMs: 1_000,
      weixinQrTotalTimeoutMs: 10_000
    });
    try {
      await runtime.start();
      const sessionResponse = await fetch(`${runtime.baseUrl}/api/v1/session`);
      const session = await sessionResponse.json() as { data: { csrfToken: string } };
      const cookie = sessionResponse.headers.get("set-cookie")!.split(";", 1)[0]!;
      const headers = {
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": session.data.csrfToken
      };

      const createResponse = await fetch(`${runtime.baseUrl}/api/v1/channels`, {
        method: "POST",
        headers,
        body: JSON.stringify({ channel: "weixin", accountId: "personal", enabled: true })
      });
      expect(createResponse.status).toBe(200);

      await eventually(async () => {
        const response = await fetch(`${runtime.baseUrl}/api/v1/channels`, { headers: { Cookie: cookie } });
        const body = await response.json() as { data: Array<{ id: string; status: string }> };
        return body.data.some((channel) => channel.id === "weixin:personal" && channel.status === "ready");
      });

      const testResponse = await fetch(`${runtime.baseUrl}/api/v1/channels/weixin%3Apersonal/test`, {
        method: "POST",
        headers,
        body: "{}"
      });
      expect(testResponse.status).toBe(200);
      await expect(testResponse.json()).resolves.toMatchObject({
        data: { ok: true, message: "Weixin worker IPC round-trip succeeded" }
      });

      fakeLogin.pollResponses.push("wait");
      const loginResponse = await fetch(`${runtime.baseUrl}/api/v1/channels/weixin%3Apersonal/login`, {
        method: "POST",
        headers,
        body: JSON.stringify({ force: false })
      });
      expect(loginResponse.status).toBe(200);
      await expect(loginResponse.json()).resolves.toMatchObject({
        data: { status: "awaiting_scan", qrCodeContent: "weixin-test-qr-content" }
      });

      fakeLogin.pollResponses.push("scaned", "scaned_but_redirect", "wait");
      const forceResponse = await fetch(`${runtime.baseUrl}/api/v1/channels/weixin%3Apersonal/login`, {
        method: "POST",
        headers,
        body: JSON.stringify({ force: true })
      });
      expect(forceResponse.status).toBe(200);
      await eventually(async () => {
        const response = await fetch(`${runtime.baseUrl}/api/v1/channels/weixin%3Apersonal/login`, {
          headers: { Cookie: cookie }
        });
        const body = await response.json() as { data: { status: string } };
        return body.data.status === "awaiting_confirmation";
      });

      const persistedLoginState = await import("node:fs/promises").then(({ readFile }) =>
        readFile(path.join(dataDirectory, "weixin-login-state.json"), "utf8")
      );
      expect(persistedLoginState).not.toContain("weixin-test-qr-content");

      const logoutResponse = await fetch(`${runtime.baseUrl}/api/v1/channels/weixin%3Apersonal/login`, {
        method: "DELETE",
        headers
      });
      expect(logoutResponse.status).toBe(200);
      await expect(logoutResponse.json()).resolves.toMatchObject({ data: { status: "logged_out" } });

      const restartResponse = await fetch(`${runtime.baseUrl}/api/v1/channels/weixin%3Apersonal/restart`, {
        method: "POST",
        headers,
        body: "{}"
      });
      expect(restartResponse.status).toBe(200);
      await eventually(async () => {
        const response = await fetch(`${runtime.baseUrl}/api/v1/channels`, { headers: { Cookie: cookie } });
        const body = await response.json() as { data: Array<{ id: string; status: string }> };
        return body.data.some((channel) => channel.id === "weixin:personal" && channel.status === "ready");
      });

      const eventsResponse = await fetch(`${runtime.baseUrl}/api/v1/diagnostics/events?limit=50`, {
        headers: { Cookie: cookie }
      });
      const events = await eventsResponse.json() as { data: { items: Array<{ type: string }> } };
      expect(events.data.items.map((event) => event.type)).toEqual(expect.arrayContaining([
        "weixin.worker.authenticated",
        "weixin.worker.ready",
        "weixin.login.state_changed"
      ]));
      expect(JSON.stringify(events)).not.toContain("weixin-test-qr-content");

      const deleteResponse = await fetch(`${runtime.baseUrl}/api/v1/channels/weixin%3Apersonal`, {
        method: "DELETE",
        headers
      });
      expect(deleteResponse.status).toBe(200);
      const channelsAfterDelete = await fetch(`${runtime.baseUrl}/api/v1/channels`, {
        headers: { Cookie: cookie }
      });
      await expect(channelsAfterDelete.json()).resolves.toMatchObject({ data: [] });
      const healthAfterDelete = await fetch(`${runtime.baseUrl}/api/v1/health`, {
        headers: { Cookie: cookie }
      });
      await expect(healthAfterDelete.json()).resolves.toMatchObject({
        data: {
          components: expect.arrayContaining([
            expect.objectContaining({ component: "weixin-worker", message: expect.stringContaining("disabled") })
          ])
        }
      });
    } finally {
      await runtime.stop();
      await fakeLogin.close();
    }
  }, 15_000);
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a loopback test port");
  }
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startFakeWeixinLoginServer(): Promise<{
  baseUrl: string;
  pollResponses: string[];
  close(): Promise<void>;
}> {
  const pollResponses: string[] = [];
  let qrSequence = 0;
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("Content-Type", "application/json");
    if (url.pathname === "/ilink/bot/get_bot_qrcode") {
      qrSequence += 1;
      response.end(JSON.stringify({
        qrcode: `session-${qrSequence}`,
        qrcode_img_content: "weixin-test-qr-content"
      }));
      return;
    }
    if (url.pathname === "/ilink/bot/get_qrcode_status") {
      response.end(JSON.stringify({ status: pollResponses.shift() ?? "wait" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start fake Weixin login server");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    pollResponses,
    close: () => closeHttpServer(server)
  };
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function eventually(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
