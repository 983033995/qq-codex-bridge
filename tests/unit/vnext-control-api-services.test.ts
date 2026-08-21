import { describe, expect, it, vi } from "vitest";
import {
  ControlApiApplicationServices,
  ControlDaemonCompositionRoot
} from "../../apps/control-daemon/src/index.js";
import { BindConversationSpace } from "../../packages/application/src/index.js";
import {
  calculateConfigRevision,
  createDefaultConfig,
  MemorySecretStore,
  type VNextConfig
} from "../../packages/config/src/index.js";
import {
  createChannelAccountId,
  createConversationSpaceId,
  type ComponentHealth,
  type Turn
} from "../../packages/domain/src/vnext/index.js";
import type { ConfigSnapshot, ConfigStorePort } from "../../packages/ports/src/vnext/index.js";
import {
  ControllableCodexPort,
  FixedClock,
  MemoryConversationSpaceRepository,
  MemoryMessageLedger,
  MemoryPushRepository,
  MemoryRoutingDecisionRepository,
  MemoryRuntimeEventRepository,
  MemoryThreadBindingRepository,
  MemoryTurnRepository,
  SequenceIdGenerator
} from "../support/vnext-fakes.js";

describe("vNext control API application services", () => {
  it("returns real health, system, configured channel, space, and event data", async () => {
    const fixture = await createFixture();
    const accountId = createChannelAccountId("qq", "bot");
    const spaceId = createConversationSpaceId(accountId, "group", "room-1");
    await fixture.spaces.save({
      spaceId,
      channel: "qq",
      accountId,
      providerConversationId: "room-1",
      scope: "group",
      displayName: "项目群",
      status: "active",
      lastInboundAt: "2026-08-10T06:00:00.000Z",
      lastOutboundAt: null
    });
    fixture.events.values.push({
      eventId: "event-1",
      component: "control-daemon",
      type: "daemon.state.changed",
      payloadJson: "{\"state\":\"running\"}",
      createdAt: "2026-08-10T06:00:00.000Z"
    });

    const health = await fixture.services.execute(invocation("health.get")) as { components: ComponentHealth[] };
    const system = await fixture.services.execute(invocation("system.status"));
    const channels = await fixture.services.execute(invocation("channels.list")) as unknown[];
    const spaces = await fixture.services.execute(invocation("spaces.list", { query: { limit: 20 } })) as { items: unknown[] };
    const events = await fixture.services.execute(invocation("diagnostics.events.list", { query: { limit: 20 } })) as { items: Array<{ occurredAt: string; payload: unknown }> };

    expect(health.components).toHaveLength(1);
    expect(system).toMatchObject({ state: "running", activeRevision: null, version: "0.2.0" });
    expect(channels).toEqual([]);
    expect(spaces.items).toEqual([expect.objectContaining({ spaceId, displayName: "项目群", binding: null })]);
    expect(events.items).toEqual([expect.objectContaining({ occurredAt: "2026-08-10T06:00:00.000Z", payload: { state: "running" } })]);
  });

  it("applies a validated config and only reports the revision after the daemon accepts it", async () => {
    const fixture = await createFixture();
    const candidate = createDefaultConfig();

    const plan = await fixture.services.execute(invocation("config.plan", { body: { candidate } })) as { revision: string };
    const applied = await fixture.services.execute(invocation("config.apply", {
      body: { candidate, secretChanges: [] }
    })) as { revision: string };
    const system = await fixture.services.execute(invocation("system.status"));

    expect(plan.revision).toBe(calculateConfigRevision(candidate));
    expect(applied.revision).toBe(plan.revision);
    expect(system).toMatchObject({ activeRevision: plan.revision });
    expect((await fixture.configStore.read())?.revision).toBe(plan.revision);
  });

  it("returns and controls the Weixin login state through the channel runtime", async () => {
    const loginState = {
      accountId: "weixin:personal",
      status: "awaiting_scan",
      message: "请使用微信扫码",
      updatedAt: "2026-08-10T06:00:00.000Z",
      qrCodeContent: "test-qr-content",
      expiresAt: "2026-08-10T06:08:00.000Z"
    };
    const runtime = {
      health: async () => ({ status: "ready", message: "worker ready", lastActivityAt: null }),
      loginStatus: async () => loginState,
      startLogin: async (_id: string, force: boolean) => ({ ...loginState, force }),
      logout: async () => ({ ...loginState, status: "logged_out", message: "尚未登录" })
    };
    const config = {
      ...createDefaultConfig(),
      channels: [{ channel: "weixin" as const, accountId: "personal", enabled: true }]
    };
    const fixture = await createFixture({ config, channels: runtime });

    const channels = await fixture.services.execute(invocation("channels.list")) as Array<{ login: unknown }>;
    const started = await fixture.services.execute(invocation("channels.login.start", {
      params: { id: "weixin:personal" },
      body: { force: true }
    }));
    const status = await fixture.services.execute(invocation("channels.login.status", {
      params: { id: "weixin:personal" }
    }));
    const loggedOut = await fixture.services.execute(invocation("channels.login.logout", {
      params: { id: "weixin:personal" }
    }));

    expect(channels[0]).toMatchObject({ login: loginState });
    expect(started).toMatchObject({ status: "awaiting_scan", force: true });
    expect(status).toEqual(loginState);
    expect(loggedOut).toMatchObject({ status: "logged_out" });
  });

  it("creates a visible binding and persists an interrupted Turn terminal state", async () => {
    const fixture = await createFixture();
    const accountId = createChannelAccountId("weixin", "personal");
    const spaceId = createConversationSpaceId(accountId, "c2c", "friend-1");
    await fixture.spaces.save({
      spaceId,
      channel: "weixin",
      accountId,
      providerConversationId: "friend-1",
      scope: "c2c",
      displayName: "小王",
      status: "active",
      lastInboundAt: null,
      lastOutboundAt: null
    });
    const thread = await fixture.codex.createThread({ title: "小王的线程" });
    const handle = await fixture.codex.startTurn({
      threadId: thread.threadId,
      idempotencyKey: "message-1",
      content: { text: "处理中", mentions: [], attachments: [] }
    });
    void handle.completion.catch(() => undefined);
    const turn: Turn = {
      turnId: handle.turnId,
      threadId: thread.threadId,
      spaceId,
      inboundMessageId: "message-1",
      status: "running",
      transport: "app-server",
      errorCode: null,
      queuedAt: "2026-08-10T06:00:00.000Z",
      startedAt: "2026-08-10T06:00:00.000Z",
      completedAt: null
    };
    await fixture.turns.save(turn);

    const binding = await fixture.services.execute(invocation("spaces.bindings.create", {
      params: { id: spaceId },
      body: { threadId: thread.threadId, mode: "exclusive", replaceActive: false }
    }));
    const interrupted = await fixture.services.execute(invocation("turns.interrupt", {
      params: { id: turn.turnId }
    }));

    expect(binding).toMatchObject({ spaceId, threadId: thread.threadId, status: "active" });
    expect(interrupted).toMatchObject({ interrupted: true });
    expect(await fixture.turns.get(turn.turnId)).toMatchObject({ status: "interrupted" });
  });

  it("exposes approval queries and resolution through the shared application service", async () => {
    const approvals = {
      list: vi.fn(async () => [{ approvalId: "approval-1", status: "pending" }]),
      get: vi.fn(async () => ({ approvalId: "approval-1", status: "pending" })),
      resolve: vi.fn(async () => ({ approvalId: "approval-1", status: "resolving", resolution: "decline" }))
    };
    const fixture = await createFixture({ approvals });

    await expect(fixture.services.execute(invocation("approvals.list", {
      query: { status: "pending", threadId: "thread-1", limit: 25 }
    }))).resolves.toEqual([{ approvalId: "approval-1", status: "pending" }]);
    await expect(fixture.services.execute(invocation("approvals.get", {
      params: { id: "approval-1" }
    }))).resolves.toMatchObject({ approvalId: "approval-1" });
    await expect(fixture.services.execute(invocation("approvals.resolve", {
      params: { id: "approval-1" },
      body: { resolution: "decline" }
    }))).resolves.toMatchObject({ status: "resolving", resolution: "decline" });

    expect(approvals.list).toHaveBeenCalledWith({ status: "pending", threadId: "thread-1", limit: 25 });
    expect(approvals.resolve).toHaveBeenCalledWith({ approvalId: "approval-1", resolution: "decline" });
  });
});

async function createFixture(options: {
  config?: VNextConfig;
  channels?: {
    health?(channelId: string): Promise<{ status: string; message: string; lastActivityAt?: string | null }>;
    test?(channelId: string): Promise<unknown>;
    restart?(channelId: string): Promise<unknown>;
    loginStatus?(channelId: string): Promise<unknown>;
    startLogin?(channelId: string, force: boolean): Promise<unknown>;
    logout?(channelId: string): Promise<unknown>;
  };
  approvals?: {
    list(input?: { status?: "pending" | "resolving" | "approved" | "declined" | "cancelled"; threadId?: string; limit?: number }): Promise<unknown[]>;
    get(approvalId: string): Promise<unknown>;
    resolve(input: { approvalId?: string; threadId?: string; resolution: "approve" | "decline" }): Promise<unknown>;
  };
} = {}) {
  const configStore = new MemoryConfigStore(options.config ?? createDefaultConfig());
  const spaces = new MemoryConversationSpaceRepository();
  const bindings = new MemoryThreadBindingRepository();
  const messages = new MemoryMessageLedger();
  const turns = new MemoryTurnRepository();
  const decisions = new MemoryRoutingDecisionRepository();
  const events = new MemoryRuntimeEventRepository();
  const push = new MemoryPushRepository();
  const codex = new ControllableCodexPort(false);
  const clock = new FixedClock();
  const daemon = new ControlDaemonCompositionRoot({
    components: [{
      name: "management-api",
      critical: true,
      start() {},
      stop() {},
      async health() {
        return { component: "management-api", status: "ready", message: "ready", since: clock.now().toISOString() };
      }
    }]
  });
  await daemon.start();
  const bindConversationSpace = new BindConversationSpace({
    spaces,
    bindings,
    codex,
    ids: new SequenceIdGenerator("binding"),
    clock
  });
  const services = new ControlApiApplicationServices({
    daemon,
    configStore,
    secretStore: new MemorySecretStore(),
    codex,
    spaces,
    bindings,
    messages,
    turns,
    listTurns: async ({ limit }) => ({ items: [...turns.values.values()].slice(0, limit), nextCursor: null }),
    decisions,
    runtimeEvents: events,
    push,
    bindConversationSpace,
    ...(options.channels ? { channels: options.channels } : {}),
    ...(options.approvals ? { approvals: options.approvals as never } : {}),
    version: "0.2.0",
    now: () => clock.now()
  });
  return { services, configStore, spaces, turns, events, codex };
}

class MemoryConfigStore implements ConfigStorePort<VNextConfig> {
  private snapshot: ConfigSnapshot<VNextConfig> | null;

  constructor(config: VNextConfig) {
    this.snapshot = { value: structuredClone(config), revision: calculateConfigRevision(config) };
  }

  async read(): Promise<ConfigSnapshot<VNextConfig> | null> {
    return this.snapshot ? structuredClone(this.snapshot) : null;
  }

  async writeAtomic(snapshot: ConfigSnapshot<VNextConfig>): Promise<void> {
    this.snapshot = structuredClone(snapshot);
  }

  async delete(): Promise<void> {
    this.snapshot = null;
  }
}

function invocation(
  operation: Parameters<ControlApiApplicationServices["execute"]>[0]["operation"],
  overrides: Partial<Parameters<ControlApiApplicationServices["execute"]>[0]> = {}
) {
  return { operation, params: {}, query: {}, body: {}, ...overrides };
}
