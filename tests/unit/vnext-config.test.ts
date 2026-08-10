import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AtomicConfigStore,
  MacOsKeychainSecretStore,
  MemorySecretStore,
  SecurityCommandError,
  applyConfiguration,
  calculateConfigRevision,
  createDefaultConfig,
  planConfigApply,
  stableSerialize,
  vnextConfigSchema,
  type SecurityCommandRunner,
  type VNextConfig
} from "../../packages/config/src/index.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("vNext config schema", () => {
  it("creates the frozen safe defaults without product .env semantics", () => {
    expect(createDefaultConfig()).toMatchObject({
      version: 1,
      runtime: { listenHost: "127.0.0.1", listenPort: 3100, maxParallelThreads: 3 },
      codex: { transport: "app-server", recoveryTransport: "cdp" },
      router: { mode: "off" },
      channels: []
    });
  });

  it("accepts HTTPS Router configuration and loopback HTTP only", () => {
    expect(vnextConfigSchema.parse(routerConfig("https://router.example/v1"))).toBeTruthy();
    expect(vnextConfigSchema.parse(routerConfig("http://127.0.0.1:8080/v1"))).toBeTruthy();
    expect(() => vnextConfigSchema.parse(routerConfig("http://router.example/v1"))).toThrow(
      /HTTPS/
    );
    expect(() => vnextConfigSchema.parse(routerConfig("https://user:pass@router.example/v1"))).toThrow(
      /HTTPS/
    );
  });

  it("rejects public management hosts, unknown fields, duplicate accounts, and incomplete Router config", () => {
    expect(() => vnextConfigSchema.parse({
      ...createDefaultConfig(),
      runtime: { ...createDefaultConfig().runtime, listenHost: "0.0.0.0" }
    })).toThrow(/loopback/);
    expect(() => vnextConfigSchema.parse({ ...createDefaultConfig(), legacyProvider: "chatgpt" })).toThrow();
    expect(() => vnextConfigSchema.parse({
      ...createDefaultConfig(),
      channels: [
        { channel: "weixin", accountId: "personal", enabled: true },
        { channel: "weixin", accountId: "personal", enabled: false }
      ]
    })).toThrow(/Duplicate channel account/);
    expect(() => vnextConfigSchema.parse({
      ...createDefaultConfig(),
      router: { ...createDefaultConfig().router, mode: "assist" }
    })).toThrow(/required when Router mode is enabled/);
  });
});

describe("vNext config revisions and atomic storage", () => {
  it("hashes object keys canonically while preserving array order", () => {
    expect(stableSerialize({ b: 2, a: 1 })).toBe(stableSerialize({ a: 1, b: 2 }));
    expect(stableSerialize([1, 2])).not.toBe(stableSerialize([2, 1]));
  });

  it("atomically round-trips a validated 0600 config snapshot", async () => {
    const filePath = await tempConfigPath();
    const store = new AtomicConfigStore(filePath);
    const value = createDefaultConfig();
    const revision = calculateConfigRevision(value);

    await store.writeAtomic({ value, revision });

    expect(await store.read()).toEqual({ value, revision });
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("fails loudly for revision mismatches and corrupt files", async () => {
    const filePath = await tempConfigPath();
    const store = new AtomicConfigStore(filePath);
    await expect(store.writeAtomic({
      value: createDefaultConfig(),
      revision: "not-the-content-hash"
    })).rejects.toThrow(/revision/);

    await writeFile(filePath, "{broken", "utf8");
    await expect(store.read()).rejects.toThrow();
  });
});

describe("vNext apply planning and rollback", () => {
  it("calculates minimal component effects from config differences", () => {
    const current = createDefaultConfig();
    const next = routerConfig("https://router.example/v1");
    next.channels.push({ channel: "weixin", accountId: "personal", enabled: true });

    expect(planConfigApply(current, next).effects).toEqual([
      { type: "hot_reload", component: "router" },
      { type: "component_restart", component: "channel:weixin:personal" }
    ]);
  });

  it("restores the previous config and secrets when apply fails", async () => {
    const configStore = new AtomicConfigStore(await tempConfigPath());
    const secretStore = new MemorySecretStore();
    const current = createDefaultConfig();
    await configStore.writeAtomic({
      value: current,
      revision: calculateConfigRevision(current)
    });
    await secretStore.set("router/default", "old-secret");

    await expect(applyConfiguration({
      configStore,
      secretStore,
      nextConfig: routerConfig("https://router.example/v1"),
      secretChanges: [{ ref: "router/default", value: "new-secret" }],
      applyPlan: async () => {
        throw new Error("component restart failed");
      }
    })).rejects.toThrow("component restart failed");

    expect(await configStore.read()).toEqual({
      value: current,
      revision: calculateConfigRevision(current)
    });
    expect(await secretStore.get("router/default")).toBe("old-secret");
  });

  it("removes first-run config and new secrets when initial apply fails", async () => {
    const configStore = new AtomicConfigStore(await tempConfigPath());
    const secretStore = new MemorySecretStore();

    await expect(applyConfiguration({
      configStore,
      secretStore,
      nextConfig: routerConfig("https://router.example/v1"),
      secretChanges: [{ ref: "router/default", value: "new-secret" }],
      applyPlan: async () => {
        throw new Error("initial health check failed");
      }
    })).rejects.toThrow("initial health check failed");

    expect(await configStore.read()).toBeNull();
    expect(await secretStore.get("router/default")).toBeNull();
  });
});

describe("macOS Keychain adapter", () => {
  it("passes secret values through stdin instead of process arguments", async () => {
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const runner: SecurityCommandRunner = async (args, input) => {
      calls.push({ args, input });
      return { stdout: "" };
    };
    const store = new MacOsKeychainSecretStore({ platform: "darwin", runner });

    await store.set("router/default", "sensitive-value");

    expect(calls[0]?.args).not.toContain("sensitive-value");
    expect(calls[0]?.args.at(-1)).toBe("-w");
    expect(calls[0]?.input).toBe("sensitive-value\n");
  });

  it("reads exact values and treats Keychain item-not-found as null", async () => {
    let missing = false;
    const runner: SecurityCommandRunner = async () => {
      if (missing) {
        throw new SecurityCommandError(44);
      }
      return { stdout: "secret-with-spaces \n" };
    };
    const store = new MacOsKeychainSecretStore({ platform: "darwin", runner });

    expect(await store.get("router/default")).toBe("secret-with-spaces ");
    missing = true;
    expect(await store.get("router/missing")).toBeNull();
    await expect(store.delete("router/missing")).resolves.toBeUndefined();
  });

  it("fails loudly when Keychain returns an unexpected command error", async () => {
    const failure = new SecurityCommandError(1);
    const runner: SecurityCommandRunner = async () => {
      throw failure;
    };
    const store = new MacOsKeychainSecretStore({ platform: "darwin", runner });

    await expect(store.get("router/default")).rejects.toBe(failure);
    await expect(store.set("router/default", "secret")).rejects.toBe(failure);
    await expect(store.delete("router/default")).rejects.toBe(failure);
  });
});

function routerConfig(baseUrl: string): VNextConfig {
  return vnextConfigSchema.parse({
    ...createDefaultConfig(),
    router: {
      ...createDefaultConfig().router,
      mode: "assist",
      baseUrl,
      model: "router-model",
      secretRef: "router/default"
    }
  });
}

async function tempConfigPath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qq-codex-vnext-config-"));
  tempDirectories.push(directory);
  return path.join(directory, "config.json");
}
