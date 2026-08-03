import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createBridgeHttpServer } from "../../apps/bridge-daemon/src/http-server.js";
import { createPushApiRoutes } from "../../packages/push/src/push-api-routes.js";
import { PushMediaGuard } from "../../packages/push/src/media-guard.js";
import { PushOrchestrator } from "../../packages/push/src/push-orchestrator.js";
import { PushRateLimiter } from "../../packages/push/src/push-rate-limiter.js";
import { SqlitePushRepository } from "../../packages/store/src/push-repo.js";
import { createSqliteDatabase } from "../../packages/store/src/sqlite.js";

describe("push api routes", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()));

  it("authenticates, queues idempotently, hides target ids, and exposes status", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-api-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repository = new SqlitePushRepository(createSqliteDatabase(":memory:"));
    await repository.saveTarget({
      alias: "daily-report-group",
      channel: "weixin",
      accountKey: "weixin:default",
      targetType: "group",
      providerTargetId: "private-wxid",
      enabled: true
    });
    const orchestrator = new PushOrchestrator({
      repository,
      targets: repository,
      mediaGuard: new PushMediaGuard(path.join(root, "outbox")),
      rateLimiter: new PushRateLimiter(100),
      createId: () => "push-api-1",
      now: () => "2026-08-03T10:00:00.000Z"
    });
    const token = "0123456789abcdef0123456789abcdef";
    const server = createBridgeHttpServer(createPushApiRoutes({ token, orchestrator }));
    cleanups.push(() => server.close());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const body = JSON.stringify({
      target: "daily-report-group",
      message: { text: "任务完成", format: "plain", media: [] },
      metadata: { source: "codex", taskId: "task-123" }
    });

    expect((await fetch(`${baseUrl}/api/v1/push`, { method: "POST", body })).status).toBe(401);
    const send = () => fetch(`${baseUrl}/api/v1/push`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "stable-key"
      },
      body
    });
    const first = await send();
    const duplicate = await send();
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ pushId: "push-api-1", status: "queued", duplicate: false });
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toEqual({ pushId: "push-api-1", status: "queued", duplicate: true });

    const status = await fetch(`${baseUrl}/api/v1/push/push-api-1/`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(status.status).toBe(200);
    const statusPayload = await status.json() as Record<string, unknown>;
    expect(statusPayload).toMatchObject({ pushId: "push-api-1", status: "queued" });
    expect(JSON.stringify(statusPayload)).not.toContain("private-wxid");
    const targets = await fetch(`${baseUrl}/api/v1/push-targets`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const targetPayload = await targets.json() as { targets: Array<Record<string, unknown>> };
    expect(targetPayload.targets[0]).toMatchObject({ alias: "daily-report-group", channel: "weixin" });
    expect(targetPayload.targets[0]).not.toHaveProperty("providerTargetId");
  });

  it("rejects raw targets and request bodies larger than 256 KiB", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-api-limit-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repository = new SqlitePushRepository(createSqliteDatabase(":memory:"));
    const orchestrator = new PushOrchestrator({
      repository,
      targets: repository,
      mediaGuard: new PushMediaGuard(path.join(root, "outbox")),
      rateLimiter: new PushRateLimiter(100)
    });
    const token = "0123456789abcdef0123456789abcdef";
    const server = createBridgeHttpServer(createPushApiRoutes({ token, orchestrator }));
    cleanups.push(() => server.close());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": "key"
    };
    const rawTarget = await fetch(`${baseUrl}/api/v1/push`, {
      method: "POST",
      headers,
      body: JSON.stringify({ target: { id: "wxid" }, message: { text: "x" } })
    });
    expect(rawTarget.status).toBe(400);
    const oversized = await fetch(`${baseUrl}/api/v1/push`, {
      method: "POST",
      headers,
      body: JSON.stringify({ target: "alias", message: { text: "x".repeat(257 * 1024) } })
    });
    expect(oversized.status).toBe(413);
  });
});
