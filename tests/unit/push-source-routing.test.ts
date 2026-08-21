import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationResolver } from "../../packages/application/src/conversation-resolver.js";
import { createChannelAccountId } from "../../packages/domain/src/vnext/index.js";
import { PushChannelRegistry } from "../../packages/push/src/channel-registry.js";
import { PushMediaGuard } from "../../packages/push/src/media-guard.js";
import { PushWorker } from "../../packages/push/src/push-worker.js";
import { PersistentPushSourceRouting } from "../../packages/push/src/source-routing.js";
import { SqlitePushRepository } from "../../packages/store/src/push-repo.js";
import { createSqliteDatabase } from "../../packages/store/src/sqlite.js";
import {
  SqliteActiveConversationRepository,
  SqliteChannelMessageRegistryRepository,
  SqliteConversationAliasRepository,
  openVNextDatabase
} from "../../packages/store-sqlite/src/index.js";

describe("persistent Push source routing", () => {
  const databases: Array<{ close(): void }> = [];

  afterEach(() => {
    for (const database of databases.splice(0).reverse()) database.close();
  });

  it("allocates Gateway-owned aliases, forces provider capability, and records scoped outbound messages", async () => {
    const database = openVNextDatabase(":memory:");
    databases.push(database);
    const aliases = new SqliteConversationAliasRepository(database);
    const registry = new SqliteChannelMessageRegistryRepository(database);
    const active = new SqliteActiveConversationRepository(database);
    const resolver = new ConversationResolver({
      aliases,
      registry,
      active,
      now: () => "2026-08-13T00:00:00.000Z"
    });
    const routing = new PersistentPushSourceRouting({
      resolver,
      registry,
      nextId: () => "registry-1"
    });
    const target = {
      alias: "review",
      channel: "weixin" as const,
      accountKey: "weixin:personal",
      targetType: "user" as const,
      providerTargetId: "peer-1",
      enabled: true,
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z"
    };

    const source = await routing.resolve({
      source: {
        provider: "claude",
        conversationId: "untrusted-client-id",
        conversationAlias: "#C999",
        taskTitle: "Code Review",
        capability: "interactive"
      },
      sourceConversationId: "claude-review-1",
      pushId: "push-1",
      target
    });
    const sameSource = await routing.resolve({
      source: { provider: "claude", capability: "push_only" },
      sourceConversationId: "claude-review-1",
      pushId: "push-2",
      target
    });

    expect(source).toMatchObject({
      provider: "claude",
      conversationId: "claude-review-1",
      capability: "push_only",
      taskTitle: "Code Review"
    });
    expect(source.conversationAlias).toMatch(/^#A[A-Z0-9]{3}$/);
    expect(source.conversationAlias).not.toBe("#C999");
    expect(sameSource.conversationAlias).toBe(source.conversationAlias);

    await routing.record({
      source,
      pushId: "push-1",
      target,
      providerMessageId: "provider-out-1",
      createdAt: "2026-08-13T00:00:01.000Z"
    });

    await expect(registry.getByChannelMessage({
      channel: "weixin",
      channelAccountId: createChannelAccountId("weixin", "personal"),
      peerId: "peer-1",
      channelMessageId: "provider-out-1"
    })).resolves.toMatchObject({
      sourceAlias: source.conversationAlias,
      provider: "claude",
      capability: "push_only",
      direction: "outbound"
    });
    await expect(active.get({
      channel: "weixin",
      channelAccountId: createChannelAccountId("weixin", "personal"),
      peerId: "peer-1"
    })).resolves.toBeNull();
  });

  it("formats and registers a successful Push without changing Active Conversation", async () => {
    const pushDatabase = createSqliteDatabase(":memory:");
    const routingDatabase = openVNextDatabase(":memory:");
    databases.push(pushDatabase, routingDatabase);
    const repository = new SqlitePushRepository(pushDatabase);
    const aliases = new SqliteConversationAliasRepository(routingDatabase);
    const registry = new SqliteChannelMessageRegistryRepository(routingDatabase);
    const active = new SqliteActiveConversationRepository(routingDatabase);
    const resolver = new ConversationResolver({ aliases, registry, active });
    const routing = new PersistentPushSourceRouting({
      resolver,
      registry,
      nextId: () => "registry-push"
    });
    await repository.saveTarget({
      alias: "codex-target",
      channel: "weixin",
      accountKey: "weixin:personal",
      targetType: "user",
      providerTargetId: "peer-1",
      enabled: true
    });
    await repository.enqueue({
      pushId: "push-codex",
      idempotencyKey: "push-codex-key",
      targetAlias: "codex-target",
      payload: {
        message: { text: "完成了", format: "plain", media: [] },
        metadata: {
          source: {
            provider: "codex",
            conversationId: "thread-a",
            conversationAlias: "#A999",
            taskTitle: "订单重构",
            capability: "push_only"
          }
        }
      },
      now: "2026-08-13T00:00:00.000Z"
    });
    const send = vi.fn(async (input: { payload: { message: { text: string; }; metadata: { source?: unknown } } }) => {
      expect(input.payload.message.text).toMatch(/^【Codex · 订单重构】[\s\S]+#C/);
      expect(input.payload.metadata.source).toMatchObject({
        provider: "codex",
        conversationId: "thread-a",
        capability: "interactive"
      });
      return { ok: true as const, providerMessageId: "provider-codex-a" };
    });
    const channels = new PushChannelRegistry();
    channels.register("weixin", "weixin:personal", { send });
    const worker = new PushWorker({
      repository,
      targets: repository,
      channels,
      mediaGuard: new PushMediaGuard("runtime/media/push-outbox-test"),
      sourceRouting: routing,
      workerId: "source-worker",
      now: () => Date.parse("2026-08-13T00:00:01.000Z")
    });

    await worker.tick();

    expect(await repository.get("push-codex")).toMatchObject({
      status: "delivered",
      providerMessageId: "provider-codex-a"
    });
    await expect(registry.getByChannelMessage({
      channel: "weixin",
      channelAccountId: createChannelAccountId("weixin", "personal"),
      peerId: "peer-1",
      channelMessageId: "provider-codex-a"
    })).resolves.toMatchObject({ provider: "codex", capability: "interactive" });
    await expect(active.get({
      channel: "weixin",
      channelAccountId: createChannelAccountId("weixin", "personal"),
      peerId: "peer-1"
    })).resolves.toBeNull();
  });
});
