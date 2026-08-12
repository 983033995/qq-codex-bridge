import { describe, expect, it, vi } from "vitest";
import { RouteInboundMessage } from "../../packages/application/src/index.js";
import type {
  ConversationSpace,
  InboundEnvelope,
  ThreadBinding
} from "../../packages/domain/src/vnext/index.js";
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
      confidence: 1
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
            confidence: 1
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
            confidence: 1
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
          return { kind: "control", action: { type: "help" }, confidence: 1 };
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
        confidence: 1
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

    await expect(service.execute(space(), message("帮我修复代码"))).resolves.toEqual({ kind: "chat" });
    expect(errors).toEqual([expect.objectContaining({ message: "router timeout" })]);
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
