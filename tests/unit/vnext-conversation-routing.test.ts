import { afterEach, describe, expect, it } from "vitest";
import {
  ConversationResolver,
  stripConversationAlias
} from "../../packages/application/src/index.js";
import { formatSourceContent } from "../../apps/control-daemon/src/weixin-message-runtime.js";
import type {
  ChannelMessageRegistryEntry,
  ConversationSpace,
  InboundEnvelope
} from "../../packages/domain/src/vnext/index.js";
import {
  SqliteActiveConversationRepository,
  SqliteChannelMessageRegistryRepository,
  SqliteConversationAliasRepository,
  openVNextDatabase,
  type SqliteDatabase
} from "../../packages/store-sqlite/src/index.js";

describe("Source & Reply Routing P0", () => {
  const databases: SqliteDatabase[] = [];

  afterEach(() => {
    for (const database of databases.splice(0).reverse()) database.close();
  });

  it("resolves reply-to before explicit alias and active conversation", async () => {
    const { resolver, aliases, registry, active } = createResolver();
    const current = await resolver.ensureAlias({
      provider: "codex",
      sourceConversationId: "thread-current",
      taskTitle: "当前任务",
      capability: "interactive"
    });
    const referenced = await resolver.ensureAlias({
      provider: "codex",
      sourceConversationId: "thread-referenced",
      taskTitle: "被引用任务",
      capability: "interactive"
    });
    await active.save({
      ...scope(),
      conversationAlias: current.alias,
      sourceConversationId: current.sourceConversationId,
      updatedBy: "admin",
      updatedAt: "2026-08-13T00:00:00.000Z"
    });
    await registry.save(registryEntry(referenced.alias, "provider-referenced"));

    const reply = await resolver.resolveInboundTarget({
      space: space(),
      message: inbound({
        replyToProviderMessageId: "provider-referenced",
        text: `${current.alias} 继续检查`
      })
    });
    expect(reply).toMatchObject({
      kind: "interactive",
      matchedBy: "reply_reference",
      alias: { alias: referenced.alias }
    });

    const explicit = await resolver.resolveInboundTarget({
      space: space(),
      message: inbound({ text: `${referenced.alias} 继续检查` })
    });
    expect(explicit).toMatchObject({
      kind: "interactive",
      matchedBy: "explicit_alias",
      alias: { alias: referenced.alias }
    });

    const fallback = await resolver.resolveInboundTarget({
      space: space(),
      message: inbound({ text: "继续检查" })
    });
    expect(fallback).toMatchObject({
      kind: "interactive",
      matchedBy: "active_conversation",
      alias: { alias: current.alias }
    });

    expect(await aliases.get(current.alias)).toMatchObject({ sourceConversationId: "thread-current" });
  });

  it("returns push_only and enforces channel/peer scope", async () => {
    const { resolver, registry } = createResolver();
    const push = await resolver.ensureAlias({
      provider: "claude",
      sourceConversationId: "claude-review",
      taskTitle: "Code Review",
      capability: "push_only"
    });
    await registry.save(registryEntry(push.alias, "provider-claude"));

    const pushResolution = await resolver.resolveInboundTarget({
      space: space(),
      message: inbound({ replyToProviderMessageId: "provider-claude" })
    });
    expect(pushResolution).toMatchObject({
      kind: "push_only",
      matchedBy: "reply_reference",
      alias: { alias: push.alias }
    });
    expect(pushResolution?.kind === "push_only" ? pushResolution.message : "")
      .toContain("不能从该渠道直接继续");

    const crossScope = await resolver.resolveInboundTarget({
      space: space("another-peer"),
      message: inbound({ text: push.alias })
    });
    expect(crossScope).toEqual({
      kind: "clarify",
      text: `没有找到 ${push.alias}。发送 /sessions 查看最近会话。`
    });
  });

  it("keeps Active on the original Codex thread while two thread messages are pushed", async () => {
    const { resolver, registry, active } = createResolver();
    const threadA = await resolver.ensureAlias({
      provider: "codex",
      sourceConversationId: "thread-a",
      taskTitle: "订单项目",
      capability: "interactive"
    });
    const threadB = await resolver.ensureAlias({
      provider: "codex",
      sourceConversationId: "thread-b",
      taskTitle: "PageMind 项目",
      capability: "interactive"
    });
    await active.save({
      ...scope(),
      conversationAlias: threadA.alias,
      sourceConversationId: threadA.sourceConversationId,
      updatedBy: "admin",
      updatedAt: "2026-08-13T00:00:00.000Z"
    });
    await registry.save(registryEntry(threadA.alias, "provider-a"));
    await registry.save(registryEntry(threadB.alias, "provider-b"));

    const sessions = await resolver.listRecentConversations({ space: space(), limit: 10 });
    expect(sessions.map((session) => session.alias)).toEqual(
      expect.arrayContaining([threadA.alias, threadB.alias])
    );
    expect(sessions.find((session) => session.alias === threadA.alias)?.active).toBe(true);
    expect(sessions.find((session) => session.alias === threadB.alias)?.active).toBe(false);

    await expect(resolver.resolveInboundTarget({
      space: space(),
      message: inbound({ text: "继续检查" })
    })).resolves.toMatchObject({
      kind: "interactive",
      matchedBy: "active_conversation",
      alias: { alias: threadA.alias }
    });
    await expect(active.get(scope())).resolves.toMatchObject({ conversationAlias: threadA.alias });

    await expect(resolver.resolveInboundTarget({
      space: space(),
      message: inbound({ replyToProviderMessageId: "provider-b", text: "再跑一次" })
    })).resolves.toMatchObject({
      kind: "interactive",
      matchedBy: "reply_reference",
      alias: { alias: threadB.alias }
    });
    await resolver.setActiveConversation({
      space: space(),
      alias: threadB.alias,
      updatedBy: "reply_reference"
    });
    await expect(active.get(scope())).resolves.toMatchObject({
      conversationAlias: threadB.alias,
      updatedBy: "reply_reference"
    });
  });

  it("keeps source metadata visible while stripping aliases from Codex input", () => {
    expect(stripConversationAlias("#C7K2 继续检查\n第二行")).toBe("继续检查\n第二行");
    expect(stripConversationAlias("继续检查 #C7K2")).toBe("继续检查");

    const formatted = formatSourceContent({
      text: "订单详情页重构完成。",
      mentions: [],
      attachments: [],
      source: {
        provider: "codex",
        taskTitle: "订单详情页重构",
        conversationAlias: "#C7K2",
        capability: "interactive"
      }
    });
    expect(formatted.text).toBe("【Codex · 订单详情页重构】\n\n订单详情页重构完成。\n\n#C7K2");
  });

  function createResolver() {
    const database = openVNextDatabase(":memory:");
    databases.push(database);
    const aliases = new SqliteConversationAliasRepository(database);
    const registry = new SqliteChannelMessageRegistryRepository(database);
    const active = new SqliteActiveConversationRepository(database);
    return {
      aliases,
      registry,
      active,
      resolver: new ConversationResolver({
        aliases,
        registry,
        active,
        now: () => "2026-08-13T00:00:00.000Z"
      })
    };
  }

  function scope() {
    return {
      channel: "weixin" as const,
      channelAccountId: "weixin:personal" as ConversationSpace["accountId"],
      peerId: "peer-1"
    };
  }

  function space(peerId = "peer-1"): ConversationSpace {
    return {
      spaceId: `weixin:personal::c2c:${peerId}` as ConversationSpace["spaceId"],
      channel: "weixin",
      accountId: "weixin:personal" as ConversationSpace["accountId"],
      providerConversationId: peerId,
      scope: "c2c",
      displayName: peerId,
      status: "active",
      lastInboundAt: null,
      lastOutboundAt: null
    };
  }

  function inbound(overrides: Partial<InboundEnvelope["content"]> = {}): InboundEnvelope {
    return {
      messageId: "gateway-message",
      providerMessageId: "provider-inbound",
      spaceId: space().spaceId,
      senderId: "user",
      receivedSequence: 1,
      receivedAt: "2026-08-13T00:00:00.000Z",
      content: {
        text: "继续检查",
        mentions: [],
        attachments: [],
        ...overrides
      }
    };
  }

  function registryEntry(sourceAlias: string, channelMessageId: string): ChannelMessageRegistryEntry {
    return {
      registryId: `registry-${channelMessageId}`,
      ...scope(),
      channelMessageId,
      gatewayMessageId: `gateway-${channelMessageId}`,
      provider: "codex",
      sourceConversationId: "source-conversation",
      sourceAlias,
      taskId: null,
      capability: "interactive",
      direction: "outbound",
      createdAt: "2026-08-13T00:00:00.000Z"
    };
  }
});
