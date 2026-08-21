import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SetupService } from "../../packages/setup/src/index.js";
import {
  openVNextDatabase,
  SqliteSetupRepository
} from "../../packages/store-sqlite/src/index.js";

describe("persistent channel SetupService", () => {
  it("persists a Weixin QR session and restores progress without storing login secrets", async () => {
    const database = openVNextDatabase(":memory:");
    const repository = new SqliteSetupRepository(database);
    const configureChannel = vi.fn(async () => ({ restartRequired: false }));
    const startLogin = vi.fn(async () => ({
      status: "awaiting_scan",
      message: "请使用微信扫码",
      qrCodeContent: "weixin-qr-content",
      expiresAt: "2026-08-13T08:08:00.000Z"
    }));
    const service = new SetupService({
      repository,
      configureChannel,
      channels: {
        startLogin,
        loginStatus: async () => ({
          status: "logged_in",
          message: "微信已登录"
        })
      },
      nextId: () => "setup-weixin-1",
      now: () => new Date("2026-08-13T08:00:00.000Z")
    });
    try {
      const started = await service.start({ channel: "weixin", accountId: "personal" });
      expect(started).toMatchObject({
        setupId: "setup-weixin-1",
        status: "awaiting_scan",
        artifact: { type: "qr_code", content: "weixin-qr-content" }
      });
      expect(configureChannel).toHaveBeenCalledWith({ channel: "weixin", accountId: "personal" });
      expect(startLogin).toHaveBeenCalledWith("weixin:personal", false);

      const restored = new SetupService({
        repository,
        configureChannel,
        channels: { loginStatus: async () => ({ status: "logged_in", message: "微信已登录" }) },
        nextId: randomUUID
      });
      await expect(restored.get("setup-weixin-1")).resolves.toMatchObject({
        status: "connected",
        artifact: null
      });
      const raw = database.prepare("SELECT * FROM setup_sessions WHERE setup_id = ?")
        .get("setup-weixin-1");
      expect(JSON.stringify(raw)).not.toContain("clientSecret");
      expect(JSON.stringify(raw)).not.toContain("token");
    } finally {
      database.close();
    }
  });

  it("returns a write-only credential form and persists restart-required without secret values", async () => {
    const database = openVNextDatabase(":memory:");
    const repository = new SqliteSetupRepository(database);
    const configureChannel = vi.fn(async () => ({ restartRequired: true }));
    const service = new SetupService({
      repository,
      configureChannel,
      nextId: () => "setup-feishu-1",
      now: () => new Date("2026-08-13T08:00:00.000Z")
    });
    try {
      const started = await service.start({ channel: "feishu", accountId: "team" });
      expect(started).toMatchObject({
        status: "awaiting_input",
        artifact: {
          type: "form",
          fields: expect.arrayContaining([
            { name: "clientSecret", secret: true, required: true }
          ])
        }
      });
      const submitted = await service.submit(started.setupId, {
        appId: "cli_app_id",
        clientSecret: "super-secret-value"
      });
      expect(submitted).toMatchObject({ status: "restart_required", artifact: null });
      expect(JSON.stringify(submitted)).not.toContain("super-secret-value");
      expect(configureChannel).toHaveBeenCalledWith({
        channel: "feishu",
        accountId: "team",
        appId: "cli_app_id",
        secretRef: "feishu/team/client-secret",
        clientSecret: "super-secret-value"
      });
      const raw = database.prepare("SELECT * FROM setup_sessions WHERE setup_id = ?")
        .get(started.setupId);
      expect(JSON.stringify(raw)).not.toContain("super-secret-value");
    } finally {
      database.close();
    }
  });

  it("reuses an active session and cancellation is idempotent", async () => {
    const database = openVNextDatabase(":memory:");
    const repository = new SqliteSetupRepository(database);
    const service = new SetupService({
      repository,
      configureChannel: async () => ({ restartRequired: false }),
      nextId: () => "setup-qq-1"
    });
    try {
      const first = await service.start({ channel: "qq", accountId: "bot" });
      const reused = await service.start({ channel: "qq", accountId: "bot" });
      const cancelled = await service.cancel(first.setupId);
      const again = await service.cancel(first.setupId);
      expect(reused.setupId).toBe(first.setupId);
      expect(cancelled.status).toBe("cancelled");
      expect(again).toEqual(cancelled);
    } finally {
      database.close();
    }
  });
});
