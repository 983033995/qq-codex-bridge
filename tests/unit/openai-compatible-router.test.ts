import { describe, expect, it, vi } from "vitest";
import { createDefaultConfig, MemorySecretStore } from "../../packages/config/src/index.js";
import { OpenAiCompatibleIntentRouter } from "../../packages/router-openai-compatible/src/index.js";
import type { ConfigSnapshot, ConfigStorePort } from "../../packages/ports/src/vnext/index.js";

describe("OpenAiCompatibleIntentRouter", () => {
  it("calls the Responses API and validates an allowed decision", async () => {
    const config = configuredRouter();
    const secrets = new MemorySecretStore();
    await secrets.set("router/cliproxyapi", "test-key");
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer test-key" });
      return new Response(JSON.stringify({
        id: "resp-1",
        output: [{ content: [{ type: "output_text", text: "{\"kind\":\"control\",\"action\":{\"type\":\"thread.list\"},\"confidence\":0.98}" }] }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const router = new OpenAiCompatibleIntentRouter({
      configStore: fixedConfig(config),
      secretStore: secrets,
      fetchFn: fetchFn as typeof fetch
    });

    await expect(router.route(input())).resolves.toEqual({
      kind: "control",
      action: { type: "thread.list" },
      confidence: 0.98,
      providerRequestId: "resp-1"
    });
    expect(fetchFn).toHaveBeenCalledWith("http://127.0.0.1:4100/v1/responses", expect.any(Object));
    await expect(router.health()).resolves.toMatchObject({ status: "ready", lastSuccessAt: expect.any(String) });
  });

  it("fails closed for a disallowed action", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("router/cliproxyapi", "test-key");
    const router = new OpenAiCompatibleIntentRouter({
      configStore: fixedConfig(configuredRouter()),
      secretStore: secrets,
      fetchFn: async () => new Response(JSON.stringify({
        output_text: "{\"kind\":\"control\",\"action\":{\"type\":\"push.send\",\"target\":\"x\",\"content\":\"x\"},\"confidence\":0.99}"
      }), { status: 200 })
    });

    await expect(router.route(input())).rejects.toThrow("disallowed action 'push.send'");
    await expect(router.health()).resolves.toMatchObject({ status: "degraded", code: "ROUTER_REQUEST_FAILED" });
  });

  it("reports missing secrets without calling the provider", async () => {
    const fetchFn = vi.fn();
    const router = new OpenAiCompatibleIntentRouter({
      configStore: fixedConfig(configuredRouter()),
      secretStore: new MemorySecretStore(),
      fetchFn
    });

    await expect(router.health()).resolves.toMatchObject({
      status: "action_required",
      code: "ROUTER_SECRET_MISSING"
    });
    await expect(router.route(input())).rejects.toThrow("is unavailable");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

function configuredRouter() {
  const config = createDefaultConfig();
  return {
    ...config,
    router: {
      ...config.router,
      mode: "assist" as const,
      baseUrl: "http://127.0.0.1:4100/v1",
      model: "MiniMax-M3",
      secretRef: "router/cliproxyapi"
    }
  };
}

function fixedConfig(value: ReturnType<typeof configuredRouter>): ConfigStorePort<typeof value> {
  const snapshot: ConfigSnapshot<typeof value> = { value, revision: "revision" };
  return {
    async read() { return snapshot; },
    async writeAtomic() {},
    async delete() {}
  };
}

function input() {
  return {
    message: "列出线程",
    spaceDisplayName: "管理台测试",
    currentThreadTitle: null,
    candidateThreads: [],
    recentControlMessages: [],
    allowedActionTypes: ["thread.list"]
  };
}
