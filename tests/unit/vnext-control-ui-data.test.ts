import { describe, expect, it, vi } from "vitest";
import {
  createChannel,
  deleteChannel,
  loadChannels,
  loadOverview,
  logoutChannel,
  restartChannel,
  startChannelLogin,
  testChannel,
  type ControlClient
} from "../../apps/control-ui/src/control-data.js";
import {
  loadTasks,
  resolveApproval,
  type ControlClient as OperationsControlClient
} from "../../apps/control-ui/src/operations-data.js";

describe("vNext control UI data", () => {
  it("loads dashboard resources in parallel and normalizes real API records", async () => {
    const requested: string[] = [];
    let active = 0;
    let maxActive = 0;
    const responses: Record<string, unknown> = {
      "/health": {
        status: "degraded",
        checkedAt: "2026-08-10T12:00:00.000Z",
        components: [
          { component: "codex-appserver", status: "ready", message: "connected", since: "2026-08-10T11:00:00.000Z" },
          { component: "feishu:work", status: "action_required", message: "secret missing", since: "2026-08-10T11:30:00.000Z" }
        ]
      },
      "/system/status": { state: "running", activeRevision: "revision-1234567890", version: "0.2.0" },
      "/channels": {
        items: [
          {
            channel: "weixin",
            accountId: "personal",
            displayName: "微信 · personal",
            status: "active",
            lastSuccessAt: "2026-08-10T11:59:00.000Z",
            login: {
              accountId: "weixin:personal",
              status: "awaiting_scan",
              message: "请使用微信扫码",
              updatedAt: "2026-08-10T11:59:30.000Z",
              qrCodeContent: "qr-content",
              expiresAt: "2026-08-10T12:07:30.000Z"
            }
          },
          { id: "feishu:work", channel: "feishu", accountId: "work", displayName: "飞书 · work", status: "action_required", message: "Secret 未配置" }
        ]
      },
      "/diagnostics/events?limit=5": {
        items: [{ eventId: "event-1", component: "control-daemon", type: "daemon.state.changed", occurredAt: "2026-08-10T12:00:00.000Z", payload: {} }]
      }
    };
    const client = {
      get: vi.fn(async <T>(path: string): Promise<T> => {
        requested.push(path);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return responses[path] as T;
      }),
      post: vi.fn(async <T>(): Promise<T> => undefined as T),
      delete: vi.fn(async <T>(): Promise<T> => undefined as T)
    };

    const result = await loadOverview(client as unknown as ControlClient);

    expect(maxActive).toBe(4);
    expect(requested).toEqual(["/health", "/system/status", "/channels", "/diagnostics/events?limit=5"]);
    expect(result.health.status).toBe("degraded");
    expect(result.channels).toMatchObject([
      { id: "weixin:personal", status: "ready", enabled: true, login: { status: "awaiting_scan", qrCodeContent: "qr-content" } },
      { id: "feishu:work", status: "action_required", lastActivityAt: null }
    ]);
    expect(result.activities[0]).toMatchObject({ eventId: "event-1", type: "daemon.state.changed" });
  });

  it("fails loudly when a channel response violates the UI contract", async () => {
    const client = {
      get: vi.fn(async <T>(): Promise<T> => [{ channel: "telegram", accountId: "x", status: "active" }] as T),
      post: vi.fn(async <T>(): Promise<T> => undefined as T),
      delete: vi.fn(async <T>(): Promise<T> => undefined as T)
    };
    await expect(loadChannels(client as unknown as ControlClient)).rejects.toThrow("channels[0].channel is invalid");
  });

  it("uses validated encoded channel routes for create, test, restart, login, logout, and delete", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const client = {
      get: vi.fn(async <T>(): Promise<T> => undefined as T),
      post: vi.fn(async <T>(path: string, body: unknown): Promise<T> => {
        calls.push({ method: "POST", path, body });
        return (path.endsWith("/login") ? {
          accountId: "weixin:personal",
          status: "logged_out",
          message: "尚未登录",
          updatedAt: "2026-08-10T12:00:00.000Z"
        } : undefined) as T;
      }),
      delete: vi.fn(async <T>(path: string): Promise<T> => {
        calls.push({ method: "DELETE", path });
        return (path.endsWith("/login") ? {
          accountId: "weixin:personal",
          status: "logged_out",
          message: "尚未登录",
          updatedAt: "2026-08-10T12:00:00.000Z"
        } : undefined) as T;
      })
    };

    const controlClient = client as unknown as OperationsControlClient;
    await createChannel({ channel: "qq", accountId: "bot", enabled: true, appId: "app", secretRef: "qq/bot" }, controlClient);
    await testChannel("qq:bot/primary", controlClient);
    await restartChannel("qq:bot/primary", controlClient);
    await startChannelLogin("weixin:personal/primary", true, controlClient);
    await logoutChannel("weixin:personal/primary", controlClient);
    await deleteChannel("qq:bot/primary", controlClient);

    expect(calls).toEqual([
      { method: "POST", path: "/channels", body: { channel: "qq", accountId: "bot", enabled: true, appId: "app", secretRef: "qq/bot" } },
      { method: "POST", path: "/channels/qq%3Abot%2Fprimary/test", body: {} },
      { method: "POST", path: "/channels/qq%3Abot%2Fprimary/restart", body: {} },
      { method: "POST", path: "/channels/weixin%3Apersonal%2Fprimary/login", body: { force: true } },
      { method: "DELETE", path: "/channels/weixin%3Apersonal%2Fprimary/login" },
      { method: "DELETE", path: "/channels/qq%3Abot%2Fprimary" }
    ]);
  });

  it("loads pending approvals with tasks and posts an encoded resolution", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const client = {
      get: vi.fn(async <T>(path: string): Promise<T> => {
        if (path === "/threads?limit=100") return { items: [], nextCursor: null } as T;
        if (path === "/turns?limit=100") return { items: [], nextCursor: null } as T;
        if (path === "/approvals?status=pending&limit=50") return [{
          approvalId: "approval/1",
          kind: "command_execution",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: "run tests",
          command: "pnpm test",
          cwd: "/workspace",
          grantRoot: null,
          status: "pending",
          resolution: null,
          error: null,
          createdAt: "2026-08-13T12:00:00.000Z",
          updatedAt: "2026-08-13T12:00:00.000Z",
          resolvedAt: null
        }] as T;
        throw new Error(`unexpected path ${path}`);
      }),
      post: vi.fn(async <T>(path: string, body: unknown): Promise<T> => {
        calls.push({ method: "POST", path, body });
        return undefined as T;
      }),
      delete: vi.fn(async <T>(): Promise<T> => undefined as T)
    };

    const controlClient = client as unknown as ControlClient;
    const result = await loadTasks(controlClient);
    expect(result.approvals).toHaveLength(1);
    await resolveApproval("approval/1", "decline", controlClient);
    expect(calls).toEqual([{
      method: "POST",
      path: "/approvals/approval%2F1/resolve",
      body: { resolution: "decline" }
    }]);
  });
});
