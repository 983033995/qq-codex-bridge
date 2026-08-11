import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemorySecretStore } from "../../packages/config/src/index.js";
import {
  HttpWeixinLoginProvider,
  WeixinLoginManager,
  WeixinLoginStateStore,
  type WeixinLoginProvider,
  type WeixinLoginState,
  type WeixinQrPollResult
} from "../../packages/channel-weixin/src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("vNext Weixin login manager", () => {
  it("publishes every QR state, stores credentials only in SecretStore, restores, and logs out", async () => {
    const directory = await tempDirectory();
    const statePath = path.join(directory, "weixin-login-state.json");
    const states: WeixinLoginState[] = [];
    const secrets = new MemorySecretStore();
    const provider = new FakeLoginProvider([
      { status: "scanned" },
      { status: "awaiting_confirmation", redirectBaseUrl: "https://redirect.weixin.example" },
      {
        status: "confirmed",
        credential: {
          token: "secret-bot-token",
          baseUrl: "https://api.weixin.example",
          userId: "sensitive-user-id"
        }
      }
    ]);
    const manager = await WeixinLoginManager.create({
      provider,
      secrets,
      stateStore: new WeixinLoginStateStore(statePath),
      pollDelayMs: 0,
      sleep: async () => undefined,
      onState: (state) => states.push(state)
    });

    const initial = await manager.startLogin("personal");
    expect(initial).toMatchObject({ status: "awaiting_scan", qrCodeContent: "weixin-login-content" });
    await eventually(() => states.some((state) => state.status === "logged_in"));
    expect(states.map((state) => state.status)).toEqual([
      "requesting_qr",
      "awaiting_scan",
      "scanned",
      "awaiting_confirmation",
      "logged_in"
    ]);
    await expect(manager.getCredential("personal")).resolves.toEqual({
      token: "secret-bot-token",
      baseUrl: "https://api.weixin.example",
      userId: "sensitive-user-id"
    });

    const persisted = await readFile(statePath, "utf8");
    expect(persisted).not.toContain("secret-bot-token");
    expect(persisted).not.toContain("weixin-login-content");
    expect(persisted).not.toContain("sensitive-user-id");
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);

    const restored = await WeixinLoginManager.create({
      provider: new FakeLoginProvider([]),
      secrets,
      stateStore: new WeixinLoginStateStore(statePath)
    });
    expect(restored.getState("personal").status).toBe("logged_in");
    await restored.invalidate("personal");
    expect(restored.getState("personal").status).toBe("invalid");
    await expect(restored.getCredential("personal")).resolves.toBeNull();
    await restored.logout("personal");
    expect(restored.getState("personal").status).toBe("logged_out");
    await expect(restored.getCredential("personal")).resolves.toBeNull();
  });

  it("marks interrupted QR sessions expired after restart and fails loudly on corrupt state", async () => {
    const directory = await tempDirectory();
    const statePath = path.join(directory, "weixin-login-state.json");
    const store = new WeixinLoginStateStore(statePath);
    await store.write({
      personal: {
        status: "awaiting_scan",
        updatedAt: "2026-08-11T00:00:00.000Z",
        expiresAt: "2026-08-11T00:08:00.000Z"
      }
    });
    const manager = await WeixinLoginManager.create({
      provider: new FakeLoginProvider([]),
      secrets: new MemorySecretStore(),
      stateStore: store
    });
    expect(manager.getState("personal").status).toBe("expired");

    await writeFile(statePath, "{broken", "utf8");
    await expect(WeixinLoginManager.create({
      provider: new FakeLoginProvider([]),
      secrets: new MemorySecretStore(),
      stateStore: store
    })).rejects.toThrow("state file is invalid");
  });

  it("supports forced relogin and explicit expired/invalid terminal states", async () => {
    const directory = await tempDirectory();
    const stateStore = new WeixinLoginStateStore(path.join(directory, "state.json"));
    const provider = new FakeLoginProvider([
      { status: "confirmed", credential: { token: "first-token", baseUrl: "https://api.weixin.example" } },
      { status: "expired" },
      { status: "invalid" }
    ]);
    const manager = await WeixinLoginManager.create({
      provider,
      secrets: new MemorySecretStore(),
      stateStore,
      pollDelayMs: 0,
      sleep: async () => undefined
    });
    await manager.startLogin("personal");
    await eventually(() => manager.getState("personal").status === "logged_in");
    await manager.startLogin("personal", true);
    await eventually(() => manager.getState("personal").status === "expired");
    await manager.startLogin("personal", true);
    await eventually(() => manager.getState("personal").status === "invalid");
  });

  it("serializes state-file writes across concurrent account login flows", async () => {
    const directory = await tempDirectory();
    const stateStore = new ConcurrentTrackingStateStore(path.join(directory, "state.json"));
    const manager = await WeixinLoginManager.create({
      provider: new FakeLoginProvider([{ status: "expired" }, { status: "expired" }]),
      secrets: new MemorySecretStore(),
      stateStore,
      pollDelayMs: 0,
      sleep: async () => undefined
    });

    await Promise.all([
      manager.startLogin("personal"),
      manager.startLogin("work")
    ]);
    await eventually(() => manager.getState("personal").status === "expired" && manager.getState("work").status === "expired");

    expect(stateStore.maxConcurrentWrites).toBe(1);
    expect(stateStore.latest).toMatchObject({
      personal: { status: "expired" },
      work: { status: "expired" }
    });
  });
});

describe("vNext Weixin HTTP login provider", () => {
  it("maps the real QR endpoint responses without exposing response bodies in errors", async () => {
    const requests: string[] = [];
    const responses = [
      { qrcode: "session-1", qrcode_img_content: "qr-content" },
      { status: "scaned" },
      { status: "scaned_but_redirect", redirect_host: "redirect.weixin.example" },
      { status: "confirmed", bot_token: "bot-token", baseurl: "https://api.weixin.example", ilink_user_id: "user-1" }
    ];
    const provider = new HttpWeixinLoginProvider({
      baseUrl: "http://127.0.0.1:9090",
      fetchFn: async (input) => {
        requests.push(String(input));
        return new Response(JSON.stringify(responses.shift()), { status: 200 });
      }
    });
    const signal = new AbortController().signal;
    await expect(provider.createQr(signal)).resolves.toEqual({ sessionId: "session-1", qrCodeContent: "qr-content" });
    await expect(provider.poll("session-1", "http://127.0.0.1:9090", signal)).resolves.toEqual({ status: "scanned" });
    await expect(provider.poll("session-1", "http://127.0.0.1:9090", signal)).resolves.toEqual({
      status: "awaiting_confirmation",
      redirectBaseUrl: "https://redirect.weixin.example"
    });
    await expect(provider.poll("session-1", "https://redirect.weixin.example", signal)).resolves.toEqual({
      status: "confirmed",
      credential: { token: "bot-token", baseUrl: "https://api.weixin.example", userId: "user-1" }
    });
    expect(requests[0]).toContain("get_bot_qrcode?bot_type=3");
    expect(requests[1]).toContain("get_qrcode_status?qrcode=session-1");
  });

  it("rejects credential-bearing or non-loopback HTTP endpoints", () => {
    expect(() => new HttpWeixinLoginProvider({ baseUrl: "http://example.com" })).toThrow("must use HTTPS");
    expect(() => new HttpWeixinLoginProvider({ baseUrl: "https://user:pass@example.com" })).toThrow("must use HTTPS");
  });
});

class FakeLoginProvider implements WeixinLoginProvider {
  constructor(private readonly results: WeixinQrPollResult[]) {}

  async createQr(): Promise<{ sessionId: string; qrCodeContent: string }> {
    return { sessionId: `session-${this.results.length}`, qrCodeContent: "weixin-login-content" };
  }

  async poll(): Promise<WeixinQrPollResult> {
    const result = this.results.shift();
    if (!result) return { status: "wait" };
    return result;
  }
}

class ConcurrentTrackingStateStore extends WeixinLoginStateStore {
  private activeWrites = 0;
  maxConcurrentWrites = 0;
  latest: Record<string, unknown> = {};

  override async read() {
    return {};
  }

  override async write(accounts: Parameters<WeixinLoginStateStore["write"]>[0]): Promise<void> {
    this.activeWrites += 1;
    this.maxConcurrentWrites = Math.max(this.maxConcurrentWrites, this.activeWrites);
    await new Promise((resolve) => setTimeout(resolve, 2));
    this.latest = structuredClone(accounts);
    this.activeWrites -= 1;
  }
}

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qqcb-vnext-weixin-login-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function eventually(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
