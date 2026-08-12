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

  it.each([
    ["现在在哪个线程", "thread.current"],
    ["现在是在哪个线程中", "thread.current"],
    ["当前线程是什么", "thread.current"],
    ["有哪些活动线程", "thread.list"],
    ["现在有哪些活跃会话", "thread.list"],
    ["当前任务进度", "turn.status"]
  ])("routes high-confidence channel control language deterministically: %s", async (text, actionType) => {
    const fetchFn = vi.fn();
    const router = new OpenAiCompatibleIntentRouter({
      configStore: fixedConfig(configuredRouter()),
      secretStore: new MemorySecretStore(),
      fetchFn
    });

    await expect(router.route({
      ...input(),
      message: text,
      allowedActionTypes: [actionType]
    })).resolves.toEqual({
      kind: "control",
      action: { type: actionType },
      confidence: 1
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("routes multiple independent control intents as an ordered action batch", async () => {
    const fetchFn = vi.fn();
    const router = new OpenAiCompatibleIntentRouter({
      configStore: fixedConfig(configuredRouter()),
      secretStore: new MemorySecretStore(),
      fetchFn
    });

    await expect(router.routeFast({
      message: "现在哪个线程，使用的什么模型",
      allowedActionTypes: ["thread.current", "model.current"]
    })).resolves.toEqual({
      kind: "control",
      actions: [{ type: "thread.current" }, { type: "model.current" }],
      confidence: 1
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    ["/h", { kind: "control", action: { type: "help" }, confidence: 1 }],
    ["/tn", { kind: "clarify", clarification: "用法：`/tn <新线程标题>`", confidence: 1 }],
    ["/tn 新会话", { kind: "control", action: { type: "thread.create", title: "新会话" }, confidence: 1 }]
  ])("handles legacy slash commands locally: %s", async (text, expected) => {
    const router = new OpenAiCompatibleIntentRouter({
      configStore: fixedConfig(configuredRouter()),
      secretStore: new MemorySecretStore(),
      fetchFn: vi.fn()
    });
    await expect(router.routeFast({
      message: text,
      allowedActionTypes: ["help", "thread.create"]
    })).resolves.toEqual(expected);
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
    message: "请帮我管理一下线程",
    spaceDisplayName: "管理台测试",
    currentThreadTitle: null,
    candidateThreads: [],
    recentControlMessages: [],
    allowedActionTypes: ["thread.list"]
  };
}
