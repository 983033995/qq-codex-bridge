import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  ControlDaemonCompositionRoot,
  installGracefulShutdown,
  type ControlDaemonComponent
} from "../../apps/control-daemon/src/index.js";
import {
  HealthRegistry,
  StructuredEventBus
} from "../../packages/observability/src/index.js";

describe("vNext control daemon composition root", () => {
  it("starts in order, reports health, applies effects, and stops in reverse order", async () => {
    const calls: string[] = [];
    const codex = component("codex", calls);
    const router = component("router", calls, true);
    const events = new StructuredEventBus({
      nextId: sequence("event"),
      now: () => new Date("2026-08-10T12:00:00.000Z")
    });
    const daemon = new ControlDaemonCompositionRoot({ components: [codex, router], events });

    await daemon.start();
    expect(daemon.state).toBe("running");
    await expect(daemon.health.check()).resolves.toMatchObject({ status: "ready" });
    await daemon.applyPlan({
      revision: "revision-1",
      effects: [
        { type: "hot_reload", component: "router" },
        { type: "component_restart", component: "codex" }
      ]
    });
    expect(daemon.activeRevision).toBe("revision-1");
    await daemon.stop();

    expect(calls).toEqual([
      "codex:start",
      "router:start",
      "router:reload",
      "codex:stop",
      "codex:start",
      "router:stop",
      "codex:stop"
    ]);
    expect(events.listAfter("event-2").map((event) => event.eventId)).toEqual([
      "event-3",
      "event-4",
      "event-5",
      "event-6",
      "event-7",
      "event-8",
      "event-9",
      "event-10",
      "event-11"
    ]);
  });

  it("rolls back started components when startup fails", async () => {
    const calls: string[] = [];
    const first = component("first", calls);
    const second = component("second", calls);
    second.start = vi.fn(async () => {
      calls.push("second:start");
      throw new Error("start failed");
    });
    const daemon = new ControlDaemonCompositionRoot({ components: [first, second] });

    await expect(daemon.start()).rejects.toThrow("start failed");
    expect(daemon.state).toBe("failed");
    expect(calls).toEqual(["first:start", "second:start", "first:stop"]);
  });

  it("does not activate a revision when an effect is unsupported", async () => {
    const daemon = new ControlDaemonCompositionRoot({ components: [component("codex", [])] });
    await daemon.start();

    await expect(daemon.applyPlan({
      revision: "bad-revision",
      effects: [{ type: "hot_reload", component: "codex" }]
    })).rejects.toThrow("does not support hot reload");
    expect(daemon.activeRevision).toBeNull();
    await daemon.stop();
  });

  it("handles SIGINT and SIGTERM through one graceful stop", async () => {
    const source = new EventEmitter() as EventEmitter & { exitCode?: number };
    const stop = vi.fn(async () => undefined);
    const uninstall = installGracefulShutdown({ stop }, source);

    source.emit("SIGINT");
    source.emit("SIGTERM");
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
    uninstall();
  });
});

describe("vNext observability primitives", () => {
  it("keeps bounded event history and rejects duplicate health probes", async () => {
    const bus = new StructuredEventBus({ historyLimit: 2, nextId: sequence("event") });
    bus.publish({ component: "one", type: "state", payload: { value: 1 } });
    bus.publish({ component: "two", type: "state", payload: { value: 2 } });
    bus.publish({ component: "three", type: "state", payload: { value: 3 } });
    expect(bus.listAfter().map((event) => event.eventId)).toEqual(["event-2", "event-3"]);
    expect(bus.listAfter("missing")).toEqual([]);

    const registry = new HealthRegistry({ now: () => new Date("2026-08-10T12:00:00.000Z") });
    registry.register({ component: "codex", critical: true, check: componentHealth("codex") });
    expect(() => registry.register({
      component: "codex",
      critical: false,
      check: componentHealth("codex")
    })).toThrow("already registered");
    await expect(registry.check()).resolves.toMatchObject({ status: "ready" });
  });
});

function component(name: string, calls: string[], reload = false): ControlDaemonComponent {
  return {
    name,
    critical: true,
    async start() {
      calls.push(`${name}:start`);
    },
    async stop() {
      calls.push(`${name}:stop`);
    },
    health: componentHealth(name),
    ...(reload ? {
      async reload() {
        calls.push(`${name}:reload`);
      }
    } : {})
  };
}

function componentHealth(name: string) {
  return async () => ({
    component: name,
    status: "ready" as const,
    message: "ready",
    since: "2026-08-10T12:00:00.000Z"
  });
}

function sequence(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}
