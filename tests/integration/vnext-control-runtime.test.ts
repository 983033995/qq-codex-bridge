import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { createProductionControlDaemon } from "../../apps/control-daemon/src/index.js";
import {
  AtomicConfigStore,
  calculateConfigRevision,
  createDefaultConfig
} from "../../packages/config/src/index.js";
import {
  openVNextDatabase,
  SqliteMessageLedger,
  SqliteRuntimeEventRepository,
  SqliteConversationSpaceRepository,
  SqliteTurnRepository
} from "../../packages/store-sqlite/src/index.js";
import type { ConversationSpace, InboundEnvelope } from "../../packages/domain/src/vnext/index.js";

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
          version: "0.3.0"
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

  it("reconciles a persisted running Turn before accepting new Runtime work", async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "qqcb-vnext-reconcile-runtime-"));
    temporaryDirectories.push(dataDirectory);
    const config = createDefaultConfig();
    config.runtime.listenPort = await freePort();
    await new AtomicConfigStore(path.join(dataDirectory, "config.json")).writeAtomic({
      value: config,
      revision: calculateConfigRevision(config)
    });

    const threadId = "thread-recovery";
    const turnId = "turn-recovery";
    const space: ConversationSpace = {
      spaceId: "weixin:personal::c2c:recovery" as ConversationSpace["spaceId"],
      channel: "weixin" as const,
      accountId: "weixin:personal" as ConversationSpace["accountId"],
      providerConversationId: "recovery",
      scope: "c2c" as const,
      displayName: "recovery",
      status: "active" as const,
      lastInboundAt: null,
      lastOutboundAt: null
    };
    const message: InboundEnvelope = {
      messageId: "message-recovery",
      providerMessageId: "provider-recovery",
      spaceId: space.spaceId,
      senderId: "sender-recovery",
      receivedSequence: 1,
      receivedAt: "2026-08-13T09:00:00.000Z",
      content: { text: "recover me", mentions: [], attachments: [] }
    };
    const seedDatabase = openVNextDatabase(path.join(dataDirectory, "runtime-vnext.db"));
    try {
      await new SqliteConversationSpaceRepository(seedDatabase).save(space);
      await new SqliteMessageLedger(seedDatabase).appendInbound(message, "dedupe-recovery");
      await new SqliteTurnRepository(seedDatabase).save({
        turnId,
        threadId,
        spaceId: space.spaceId,
        inboundMessageId: message.messageId,
        status: "running",
        transport: "app-server",
        errorCode: null,
        queuedAt: message.receivedAt,
        startedAt: message.receivedAt,
        completedAt: null
      });
    } finally {
      seedDatabase.close();
    }

    const appServer = await startRecoveryAppServer(threadId, turnId);
    const runtime = await createProductionControlDaemon({
      dataDirectory,
      appServerUrl: appServer.url
    });
    try {
      await runtime.start();
    } finally {
      await runtime.stop();
      await appServer.close();
    }

    const database = openVNextDatabase(path.join(dataDirectory, "runtime-vnext.db"));
    try {
      const turn = await new SqliteTurnRepository(database).get(turnId);
      expect(turn).toMatchObject({ status: "completed", completedAt: expect.any(String) });
      const events = await new SqliteRuntimeEventRepository(database).list({ limit: 20 });
      expect(events.items.map((event) => event.type)).toEqual(expect.arrayContaining([
        "turn.recovery.unknown",
        "turn.recovery.resolved"
      ]));
    } finally {
      database.close();
    }
  });
});

async function startRecoveryAppServer(threadId: string, turnId: string): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  server.on("connection", (socket) => {
    socket.on("message", (payload) => {
      const request = JSON.parse(payload.toString()) as {
        id: string | number;
        method: string;
      };
      const result = request.method === "initialize"
        ? {
            userAgent: "recovery-test-app-server",
            codexHome: "/tmp/recovery-test-codex",
            platformFamily: "unix",
            platformOs: "macos"
          }
        : request.method === "thread/read"
          ? { thread: { id: threadId, turns: [{ id: turnId, status: "completed" }] } }
          : {};
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    });
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("expected a recovery AppServer address");
  }
  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

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
