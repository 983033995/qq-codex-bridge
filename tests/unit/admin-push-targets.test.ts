import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createAdminRoutes } from "../../apps/bridge-daemon/src/admin-routes.js";
import { loadConfigFromEnv } from "../../apps/bridge-daemon/src/config.js";
import { createBridgeHttpServer } from "../../apps/bridge-daemon/src/http-server.js";
import { BridgeSessionStatus } from "../../packages/domain/src/session.js";
import { AdminRepository } from "../../packages/store/src/admin-repo.js";
import { SqlitePushRepository } from "../../packages/store/src/push-repo.js";
import { SqliteSessionStore } from "../../packages/store/src/session-repo.js";
import { createSqliteDatabase } from "../../packages/store/src/sqlite.js";

describe("admin push targets", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()));

  it("derives private provider targets only from stored sessions and never returns them", async () => {
    const db = createSqliteDatabase(":memory:");
    cleanups.push(() => db.close());
    await new SqliteSessionStore(db).createSession({
      sessionKey: "feishu:work::fs:group:oc-private-chat",
      accountKey: "feishu:work",
      peerKey: "fs:group:oc-private-chat",
      chatType: "group",
      peerId: "ou-last-sender",
      codexThreadRef: null,
      lastCodexTurnId: null,
      skillContextKey: null,
      conversationProvider: null,
      status: BridgeSessionStatus.Active,
      lastInboundAt: "2026-08-03T10:00:00.000Z",
      lastOutboundAt: null,
      lastError: null
    });
    const config = loadConfigFromEnv({
      QQBOT_APP_ID: "qq-app",
      QQBOT_CLIENT_SECRET: "qq-secret"
    });
    const targets = new SqlitePushRepository(db);
    const server = createBridgeHttpServer(createAdminRoutes({
      config,
      repository: new AdminRepository(db),
      startedAt: "2026-08-03T10:00:00.000Z",
      getChannels: () => [],
      pushTargets: targets
    }));
    cleanups.push(() => server.close());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const invalid = await fetch(`${baseUrl}/admin/api/push-targets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        alias: "raw-target",
        channel: "feishu",
        providerTargetId: "attacker-supplied"
      })
    });
    expect(invalid.status).toBe(400);

    const created = await fetch(`${baseUrl}/admin/api/push-targets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        alias: "daily-report-group",
        sessionKey: "feishu:work::fs:group:oc-private-chat",
        channel: "qq",
        providerTargetId: "attacker-supplied"
      })
    });
    expect(created.status).toBe(201);
    const createdText = await created.text();
    expect(createdText).not.toContain("oc-private-chat");
    expect(createdText).not.toContain("attacker-supplied");
    expect(JSON.parse(createdText)).toMatchObject({
      target: {
        alias: "daily-report-group",
        channel: "feishu",
        accountKey: "feishu:work",
        targetType: "group",
        enabled: true
      }
    });
    expect(await targets.getTarget("daily-report-group")).toMatchObject({
      providerTargetId: "oc-private-chat"
    });

    const disabled = await fetch(`${baseUrl}/admin/api/push-targets/daily-report-group`, {
      method: "DELETE"
    });
    expect(disabled.status).toBe(200);
    const listed = await fetch(`${baseUrl}/admin/api/push-targets`);
    const listedText = await listed.text();
    expect(listedText).not.toContain("oc-private-chat");
    expect(JSON.parse(listedText)).toMatchObject({
      targets: [{ alias: "daily-report-group", enabled: false }]
    });
  });

  it("warns that QQ push targets always fail because no verified proactive API exists", async () => {
    const db = createSqliteDatabase(":memory:");
    cleanups.push(() => db.close());
    await new SqliteSessionStore(db).createSession({
      sessionKey: "qqbot:default::qq:c2c:openid-1",
      accountKey: "qqbot:default",
      peerKey: "qq:c2c:openid-1",
      chatType: "c2c",
      peerId: "openid-1",
      codexThreadRef: null,
      lastCodexTurnId: null,
      skillContextKey: null,
      conversationProvider: null,
      status: BridgeSessionStatus.Active,
      lastInboundAt: "2026-08-03T10:00:00.000Z",
      lastOutboundAt: null,
      lastError: null
    });
    const config = loadConfigFromEnv({
      QQBOT_APP_ID: "qq-app",
      QQBOT_CLIENT_SECRET: "qq-secret"
    });
    const targets = new SqlitePushRepository(db);
    const server = createBridgeHttpServer(createAdminRoutes({
      config,
      repository: new AdminRepository(db),
      startedAt: "2026-08-03T10:00:00.000Z",
      getChannels: () => [],
      pushTargets: targets
    }));
    cleanups.push(() => server.close());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const created = await fetch(`${baseUrl}/admin/api/push-targets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        alias: "qq-alerts",
        sessionKey: "qqbot:default::qq:c2c:openid-1"
      })
    });
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.target.channel).toBe("qq");
    expect(body.warning).toMatch(/channel_unsupported/);
  });
});
