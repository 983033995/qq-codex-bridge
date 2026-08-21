import { describe, expect, it, vi } from "vitest";
import { ConversationResolver, RouteInboundMessage } from "../../packages/application/src/index.js";
import { createDefaultConfig, MemorySecretStore } from "../../packages/config/src/index.js";
import type {
  ConversationSpace,
  InboundEnvelope,
  ThreadBinding
} from "../../packages/domain/src/vnext/index.js";
import {
  SqliteActiveConversationRepository,
  SqliteChannelMessageRegistryRepository,
  SqliteConversationAliasRepository,
  openVNextDatabase
} from "../../packages/store-sqlite/src/index.js";
import { OpenAiCompatibleIntentRouter } from "../../packages/router-openai-compatible/src/index.js";
import {
  ControllableCodexPort,
  FixedClock,
  MemoryRoutingDecisionRepository,
  MemoryThreadBindingRepository,
  SequenceIdGenerator
} from "../support/vnext-fakes.js";

describe("RouteInboundMessage", () => {
  it("uses fast deterministic control routing before querying Codex threads", async () => {
    const listThreads = vi.fn(async () => { throw new Error("Codex thread list must not be queried"); });
    const route = vi.fn(async () => { throw new Error("model router must not be queried"); });
    const routeFast = vi.fn(async () => ({
      kind: "control" as const,
      action: { type: "thread.current" as const },
      confidence: 1,
      risk: "read" as const,
      mode: "auto" as const
    }));
    const service = new RouteInboundMessage({
      router: { route, routeFast },
      decisions: new MemoryRoutingDecisionRepository(),
      bindings: new MemoryThreadBindingRepository(),
      codex: { listThreads },
      controlActions: {
        async execute() {
          return {
            status: "completed" as const,
            action: { type: "thread.current" as const },
            message: "No thread is bound",
            data: null
          };
        }
      },
      ids: new SequenceIdGenerator("decision"),
      clock: new FixedClock()
    });

    await expect(service.execute(space(), message("现在是在哪个线程中"))).resolves.toEqual({
      kind: "reply",
      text: "当前渠道尚未绑定任何线程。"
    });
    expect(routeFast).toHaveBeenCalledOnce();
    expect(listThreads).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
  });

  it("formats Feishu thread lists as a markdown table", async () => {
    const service = new RouteInboundMessage({
      router: {
        async route() { throw new Error("must not use model routing"); },
        async routeFast() {
          return {
            kind: "control",
            action: { type: "thread.list" },
            confidence: 1,
            risk: "read",
            mode: "auto"
          };
        }
      },
      decisions: new MemoryRoutingDecisionRepository(),
      bindings: new MemoryThreadBindingRepository(),
      codex: { async listThreads() { return []; } },
      controlActions: {
        async execute() {
          return {
            status: "completed" as const,
            action: { type: "thread.list" as const },
            message: "Threads listed",
            data: [{
              threadId: "thread-1",
              title: "vNext | 开发",
              projectName: "qq-codex-bridge",
              updatedAt: "2026-08-11T00:00:00.000Z"
            }]
          };
        }
      },
      ids: new SequenceIdGenerator("decision"),
      clock: new FixedClock()
    });

    await expect(service.execute(space(), message("现在有哪些活动会话"))).resolves.toEqual({
      kind: "reply",
      format: "markdown",
      text: [
        "当前共有 1 个可用线程：",
        "",
        "| # | 线程 | 项目 | 线程 ID |",
        "| ---: | --- | --- | --- |",
        "| 1 | vNext \\| 开发 | qq-codex-bridge | thread-1 |"
      ].join("\n")
    });
  });

  it("executes multiple control actions in order and merges their real results", async () => {
    const decisions = new MemoryRoutingDecisionRepository();
    const execute = vi.fn(async (input: { action: { type: string } }) => input.action.type === "thread.current"
      ? {
          status: "completed" as const,
          action: { type: "thread.current" as const },
          message: "Current thread resolved",
          data: {
            bindingId: "binding-1",
            spaceId: space().spaceId,
            threadId: "thread-real",
            threadTitle: "真实绑定线程",
            mode: "exclusive" as const,
            status: "active" as const,
            createdAt: "2026-08-11T00:00:00.000Z",
            updatedAt: "2026-08-11T00:00:00.000Z"
          }
        }
      : {
          status: "completed" as const,
          action: { type: "model.current" as const },
          message: "Current model resolved",
          data: { model: "gpt-5.6", reasoningEffort: "high", quotaSummary: null }
        });
    const service = new RouteInboundMessage({
      router: {
        async route() { throw new Error("must not use model routing"); },
        async routeFast() {
          return {
            kind: "control",
            actions: [{ type: "thread.current" }, { type: "model.current" }],
            confidence: 1,
            risk: "read",
            mode: "auto"
          };
        }
      },
      decisions,
      bindings: new MemoryThreadBindingRepository(),
      codex: { async listThreads() { return []; } },
      controlActions: { execute: execute as never },
      ids: new SequenceIdGenerator("decision"),
      clock: new FixedClock()
    });

    await expect(service.execute(space(), message("现在哪个线程，使用的什么模型"))).resolves.toEqual({
      kind: "reply",
      text: "当前线程：真实绑定线程\n线程 ID：thread-real\n\n当前模型：gpt-5.6\n推理强度：high"
    });
    expect(execute.mock.calls.map(([input]) => input.action.type)).toEqual([
      "thread.current",
      "model.current"
    ]);
    expect(decisions.values[0]).toMatchObject({
      result: "control:completed:2",
      decision: { actions: [{ type: "thread.current" }, { type: "model.current" }] }
    });
  });

  it("formats /h as a user-facing command table without exposing internal action names", async () => {
    const service = new RouteInboundMessage({
      router: {
        async route() { throw new Error("must not use model routing"); },
        async routeFast() {
          return { kind: "control", action: { type: "help" }, confidence: 1, risk: "read", mode: "auto" };
        }
      },
      decisions: new MemoryRoutingDecisionRepository(),
      bindings: new MemoryThreadBindingRepository(),
      codex: { async listThreads() { return []; } },
      controlActions: {
        async execute() {
          return {
            status: "completed" as const,
            action: { type: "help" as const },
            message: "Supported actions listed",
            data: ["thread.list", "push.send"]
          };
        }
      },
      ids: new SequenceIdGenerator("decision"),
      clock: new FixedClock()
    });

    const result = await service.execute(space(), message("/h"));
    expect(result).toMatchObject({ kind: "reply", format: "markdown" });
    expect(result.kind === "reply" ? result.text : "").toContain("| 查看当前绑定线程 | `/thread current` | `/tc` |");
    expect(result.kind === "reply" ? result.text : "").not.toContain("push.send");
  });

  it("routes thread.current with conversation context, executes it, and records the decision", async () => {
    const bindings = new MemoryThreadBindingRepository();
    const decisions = new MemoryRoutingDecisionRepository();
    const codex = new ControllableCodexPort();
    const thread = await codex.createThread({ title: "vNext 开发" });
    const binding: ThreadBinding = {
      bindingId: "binding-1",
      spaceId: space().spaceId,
      threadId: thread.threadId,
      threadTitle: thread.title,
      mode: "exclusive",
      status: "active",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z"
    };
    await bindings.save(binding);
    const route = vi.fn(async (input: { currentThreadTitle: string | null; candidateThreads: unknown[] }) => {
      expect(input.currentThreadTitle).toBe("vNext 开发");
      expect(input.candidateThreads).toHaveLength(1);
      return {
        kind: "control" as const,
        action: { type: "thread.current" as const },
        confidence: 1,
        risk: "read" as const,
        mode: "auto" as const
      };
    });
    const execute = vi.fn(async () => ({
      status: "completed" as const,
      action: { type: "thread.current" as const },
      message: "Current thread resolved",
      data: binding
    }));
    const service = new RouteInboundMessage({
      router: { route: route as never },
      decisions,
      bindings,
      codex,
      controlActions: { execute: execute as never },
      ids: new SequenceIdGenerator("decision"),
      clock: new FixedClock()
    });

    await expect(service.execute(space(), message("现在在哪个线程"))).resolves.toEqual({
      kind: "reply",
      text: `当前线程：vNext 开发\n线程 ID：${thread.threadId}`
    });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      spaceId: space().spaceId,
      action: { type: "thread.current" }
    }));
    expect(decisions.values).toEqual([
      expect.objectContaining({
        messageId: "message-1",
        result: "control:completed:1",
        decision: expect.objectContaining({ kind: "control", action: { type: "thread.current" } })
      })
    ]);
  });

  it("dispatches setup and channel control without starting a Codex conversation", async () => {
    const startSetup = vi.fn(async () => ({
      status: "awaiting_scan",
      message: "请使用微信扫码",
      artifact: { type: "qr_code", content: "qr-content" }
    }));
    const restartChannel = vi.fn(async () => ({ restarted: true }));
    const router = {
      route: vi.fn(),
      routeFast: vi.fn()
        .mockResolvedValueOnce({
          kind: "setup",
          action: { type: "setup.channel.login", channel: "weixin" },
          confidence: 1,
          risk: "medium",
          mode: "auto"
        })
        .mockResolvedValueOnce({
          kind: "control",
          action: { type: "channel.restart", channel: "weixin" },
          confidence: 1,
          risk: "medium",
          mode: "auto"
        })
    };
    const service = new RouteInboundMessage({
      router,
      decisions: new MemoryRoutingDecisionRepository(),
      bindings: new MemoryThreadBindingRepository(),
      codex: { listThreads: vi.fn(async () => []) },
      controlActions: { execute: vi.fn() as never },
      systemActions: {
        startSetup,
        restartChannel,
        resolveApproval: vi.fn()
      },
      ids: new SequenceIdGenerator("decision"),
      clock: new FixedClock()
    });

    await expect(service.execute(space(), message("重新登录微信"))).resolves.toMatchObject({
      kind: "reply",
      text: expect.stringContaining("qr-content")
    });
    await expect(service.execute(space(), message("重启微信"))).resolves.toEqual({
      kind: "reply",
      text: "已重启微信渠道。"
    });
    expect(startSetup).toHaveBeenCalledWith({ channel: "weixin", force: true });
    expect(restartChannel).toHaveBeenCalledWith({ channel: "weixin" });
  });

  it("never sends approval intent to Codex when Approval Service is unavailable", async () => {
    const errors: Error[] = [];
    const decisions = new MemoryRoutingDecisionRepository();
    const service = new RouteInboundMessage({
      router: {
        async route() { throw new Error("model must not run"); },
        async routeFast() {
          return {
            kind: "approval",
            action: { type: "approval.resolve", resolution: "approve" },
            confidence: 1,
            risk: "high",
            mode: "off"
          } as const;
        }
      },
      decisions,
      bindings: new MemoryThreadBindingRepository(),
      codex: { listThreads: vi.fn(async () => []) },
      controlActions: { execute: vi.fn() as never },
      systemActions: {
        startSetup: vi.fn(),
        restartChannel: vi.fn(),
        async resolveApproval() { throw new Error("Approval Service 尚未启用"); }
      },
      ids: new SequenceIdGenerator("decision"),
      clock: new FixedClock(),
      onRoutingError(error) { errors.push(error); }
    });

    const result = await service.execute(space(), message("/approve"));
    expect(result).toMatchObject({ kind: "reply", text: expect.stringContaining("Approval Service 尚未启用") });
    expect(errors).toEqual([expect.objectContaining({ message: "Approval Service 尚未启用" })]);
    expect(decisions.values[0]).toMatchObject({
      decision: { kind: "approval" },
      result: "approval:partial:1/1"
    });
  });

  it("fails open to chat when the auxiliary router is unavailable", async () => {
    const errors: Error[] = [];
    const service = new RouteInboundMessage({
      router: { async route() { throw new Error("router timeout"); } },
      decisions: new MemoryRoutingDecisionRepository(),
      bindings: new MemoryThreadBindingRepository(),
      codex: new ControllableCodexPort(),
      controlActions: { async execute() { throw new Error("must not run"); } },
      ids: new SequenceIdGenerator("decision"),
      clock: new FixedClock(),
      onRoutingError(error) { errors.push(error); }
    });

    await expect(service.execute(space(), message("帮我修复代码"))).resolves.toEqual({ kind: "conversation" });
    expect(errors).toEqual([expect.objectContaining({ message: "router timeout" })]);
  });

  it("executes /sessions, /current, and /use through deterministic routing when the provider is unavailable", async () => {
    const database = openVNextDatabase(":memory:");
    try {
      const aliases = new SqliteConversationAliasRepository(database);
      const registry = new SqliteChannelMessageRegistryRepository(database);
      const active = new SqliteActiveConversationRepository(database);
      const resolver = new ConversationResolver({ aliases, registry, active });
      const current = await resolver.ensureAlias({
        provider: "codex",
        sourceConversationId: "thread-current",
        taskTitle: "当前任务",
        capability: "interactive"
      });
      const other = await resolver.ensureAlias({
        provider: "codex",
        sourceConversationId: "thread-other",
        taskTitle: "另一个任务",
        capability: "interactive"
      });
      await active.save({
        channel: "feishu",
        channelAccountId: space().accountId,
        peerId: "peer-1",
        conversationAlias: current.alias,
        sourceConversationId: current.sourceConversationId,
        updatedBy: "admin",
        updatedAt: "2026-08-13T00:00:00.000Z"
      });
      await registry.save({
        registryId: "registry-other",
        channel: "feishu",
        channelAccountId: space().accountId,
        peerId: "peer-1",
        channelMessageId: "provider-other",
        gatewayMessageId: "gateway-other",
        provider: "codex",
        sourceConversationId: other.sourceConversationId,
        sourceAlias: other.alias,
        taskId: null,
        capability: "interactive",
        direction: "outbound",
        createdAt: "2026-08-13T00:00:00.000Z"
      });

      const config = createDefaultConfig();
      const router = new OpenAiCompatibleIntentRouter({
        configStore: {
          async read() { return { value: config, revision: "test" }; },
          async writeAtomic() {},
          async delete() {}
        },
        secretStore: new MemorySecretStore(),
        fetchFn: vi.fn()
      });
      const service = (text: string) => new RouteInboundMessage({
        router,
        decisions: new MemoryRoutingDecisionRepository(),
        bindings: new MemoryThreadBindingRepository(),
        codex: { async listThreads() { throw new Error("Codex must not be queried"); } },
        controlActions: { async execute() { throw new Error("control action must not run"); } },
        conversationResolver: resolver,
        ids: new SequenceIdGenerator("conversation-decision"),
        clock: new FixedClock()
      }).execute(space(), message(text));

      await expect(service("/sessions")).resolves.toMatchObject({
        kind: "reply",
        text: expect.stringContaining(current.alias)
      });
      await expect(service("/current")).resolves.toEqual({
        kind: "reply",
        text: expect.stringContaining(current.alias)
      });
      await expect(service(`/use ${other.alias}`)).resolves.toMatchObject({
        kind: "reply",
        text: expect.stringContaining(`已切换到：`)
      });
      await expect(active.get({
        channel: "feishu",
        channelAccountId: space().accountId,
        peerId: "peer-1"
      })).resolves.toMatchObject({
        conversationAlias: other.alias,
        updatedBy: "explicit_switch"
      });
    } finally {
      database.close();
    }
  });
});

function space(): ConversationSpace {
  return {
    spaceId: "feishu:default::c2c:peer-1" as never,
    channel: "feishu",
    accountId: "feishu:default" as never,
    providerConversationId: "peer-1",
    scope: "c2c",
    displayName: "飞书测试",
    status: "active",
    lastInboundAt: null,
    lastOutboundAt: null
  };
}

function message(text: string): InboundEnvelope {
  return {
    messageId: "message-1",
    providerMessageId: "provider-1",
    spaceId: space().spaceId,
    senderId: "peer-1",
    receivedSequence: 1,
    receivedAt: "2026-08-11T00:00:01.000Z",
    content: { text, mentions: [], attachments: [] }
  };
}
