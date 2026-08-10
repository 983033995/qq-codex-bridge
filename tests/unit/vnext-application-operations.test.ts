import { describe, expect, it } from "vitest";
import {
  ApplyConfiguration,
  EnqueuePush,
  RunHealthCheck
} from "../../packages/application/src/index.js";
import type {
  ConfigSnapshot,
  ConfigStorePort,
  SecretStorePort
} from "../../packages/ports/src/vnext/index.js";
import {
  FixedClock,
  MemoryPushRepository,
  SequenceIdGenerator
} from "../support/vnext-fakes.js";

describe("vNext operational application use cases", () => {
  it("applies a prepared config and secret changes", async () => {
    const configStore = new MemoryConfigStore<{ mode: string }>();
    const secretStore = new MemorySecretStore();
    const applied: string[] = [];
    const useCase = new ApplyConfiguration({
      configStore,
      secretStore,
      prepare: (_current, candidate: { mode: string }) => ({
        snapshot: { revision: `revision-${candidate.mode}`, value: candidate },
        plan: `apply-${candidate.mode}`
      }),
      applyPlan: async (plan) => {
        applied.push(plan);
      }
    });

    await expect(useCase.execute({
      candidate: { mode: "ready" },
      secretChanges: [{ ref: "router/default", value: "secret-new" }]
    })).resolves.toBe("apply-ready");
    expect(await configStore.read()).toEqual({
      revision: "revision-ready",
      value: { mode: "ready" }
    });
    expect(await secretStore.get("router/default")).toBe("secret-new");
    expect(applied).toEqual(["apply-ready"]);
  });

  it("rolls config and secrets back when applying the plan fails", async () => {
    const configStore = new MemoryConfigStore<{ mode: string }>({
      revision: "revision-old",
      value: { mode: "old" }
    });
    const secretStore = new MemorySecretStore({ "router/default": "secret-old" });
    const useCase = new ApplyConfiguration({
      configStore,
      secretStore,
      prepare: (_current, candidate: { mode: string }) => ({
        snapshot: { revision: "revision-new", value: candidate },
        plan: "fail"
      }),
      applyPlan: async () => {
        throw new Error("component restart failed");
      }
    });

    await expect(useCase.execute({
      candidate: { mode: "new" },
      secretChanges: [{ ref: "router/default", value: "secret-new" }]
    })).rejects.toThrow("component restart failed");
    expect(await configStore.read()).toEqual({
      revision: "revision-old",
      value: { mode: "old" }
    });
    expect(await secretStore.get("router/default")).toBe("secret-old");
  });

  it("aggregates health and converts thrown probes to explicit component failures", async () => {
    const health = new RunHealthCheck({
      clock: new FixedClock(),
      probes: [
        {
          component: "database",
          critical: true,
          check: async () => ({
            component: "database",
            status: "ready",
            message: "ready",
            since: "2026-08-10T06:00:00.000Z"
          })
        },
        {
          component: "channel:weixin:personal",
          critical: false,
          check: async () => {
            throw new Error("login required");
          }
        }
      ]
    });

    const report = await health.execute();
    expect(report.status).toBe("degraded");
    expect(report.components[1]).toMatchObject({
      component: "channel:weixin:personal",
      status: "offline",
      code: "HEALTH_CHECK_FAILED",
      message: "login required"
    });
  });

  it("reports offline when a critical health probe fails", async () => {
    const health = new RunHealthCheck({
      clock: new FixedClock(),
      probes: [{
        component: "codex",
        critical: true,
        check: async () => {
          throw new Error("app server unavailable");
        }
      }]
    });

    expect((await health.execute()).status).toBe("offline");
  });

  it("enqueues pushes idempotently only for enabled verified targets", async () => {
    const pushes = new MemoryPushRepository();
    const clock = new FixedClock();
    const useCase = new EnqueuePush({
      pushes,
      ids: new SequenceIdGenerator("push"),
      clock
    });
    await pushes.saveTarget({
      alias: "owner",
      spaceId: "weixin:personal::c2c:owner" as never,
      enabled: true,
      createdAt: clock.now().toISOString(),
      updatedAt: clock.now().toISOString()
    });
    const input = {
      targetAlias: "owner",
      idempotencyKey: "request-1",
      content: { text: "hello", mentions: [], attachments: [] }
    };

    const first = await useCase.execute(input);
    const duplicate = await useCase.execute(input);
    expect(first).toMatchObject({ duplicate: false, job: { pushId: "push-1" } });
    expect(duplicate).toEqual({ duplicate: true, job: first.job });
    expect(JSON.parse(first.job.contentJson)).toEqual({ message: input.content });

    await expect(useCase.execute({ ...input, targetAlias: "missing" }))
      .rejects.toMatchObject({ code: "CHANNEL_DELIVERY_FAILED" });
    await pushes.saveTarget({
      ...(await pushes.getTarget("owner"))!,
      enabled: false
    });
    await expect(useCase.execute({ ...input, idempotencyKey: "request-2" }))
      .rejects.toThrow("disabled");
  });
});

class MemoryConfigStore<T> implements ConfigStorePort<T> {
  constructor(private snapshot: ConfigSnapshot<T> | null = null) {}

  async read(): Promise<ConfigSnapshot<T> | null> {
    return this.snapshot ? structuredClone(this.snapshot) : null;
  }

  async writeAtomic(snapshot: ConfigSnapshot<T>): Promise<void> {
    this.snapshot = structuredClone(snapshot);
  }

  async delete(): Promise<void> {
    this.snapshot = null;
  }
}

class MemorySecretStore implements SecretStorePort {
  private readonly values: Map<string, string>;

  constructor(initial: Record<string, string> = {}) {
    this.values = new Map(Object.entries(initial));
  }

  async get(ref: string): Promise<string | null> {
    return this.values.get(ref) ?? null;
  }

  async set(ref: string, value: string): Promise<void> {
    this.values.set(ref, value);
  }

  async delete(ref: string): Promise<void> {
    this.values.delete(ref);
  }
}
