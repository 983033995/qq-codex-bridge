import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SqliteActiveConversationRepository,
  SqliteChannelMessageRegistryRepository,
  SqliteConversationAliasRepository,
  migrateSourceRoutingData,
  openVNextDatabase,
  type SqliteDatabase
} from "../../packages/store-sqlite/src/index.js";

describe("Source & Reply Routing SQLite persistence", () => {
  const databases: SqliteDatabase[] = [];
  const directories: string[] = [];

  afterEach(() => {
    for (const database of databases.splice(0).reverse()) database.close();
    for (const directory of directories.splice(0).reverse()) fs.rmSync(directory, { recursive: true, force: true });
  });

  it("restores Alias, Channel Message Registry, and Active Conversation after restart", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omniagent-routing-"));
    directories.push(directory);
    const databasePath = path.join(directory, "runtime-vnext.db");
    const first = track(openVNextDatabase(databasePath));
    const aliases = new SqliteConversationAliasRepository(first);
    const registry = new SqliteChannelMessageRegistryRepository(first);
    const active = new SqliteActiveConversationRepository(first);
    const alias = {
      alias: "#C7K2",
      provider: "codex",
      instanceId: null,
      sourceConversationId: "thread-orders",
      projectId: null,
      projectName: "admin-refactor",
      taskId: "task-orders",
      taskTitle: "订单详情页重构",
      capability: "interactive" as const,
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z"
    };
    await aliases.save(alias);
    await registry.save({
      registryId: "registry-1",
      channel: "weixin",
      channelAccountId: "weixin:personal" as never,
      peerId: "peer-1",
      channelMessageId: "provider-1",
      gatewayMessageId: "delivery-1",
      provider: "codex",
      sourceConversationId: alias.sourceConversationId,
      sourceAlias: alias.alias,
      taskId: alias.taskId,
      capability: "interactive",
      direction: "outbound",
      createdAt: alias.createdAt
    });
    await active.save({
      channel: "weixin",
      channelAccountId: "weixin:personal" as never,
      peerId: "peer-1",
      conversationAlias: alias.alias,
      sourceConversationId: alias.sourceConversationId,
      updatedBy: "explicit_switch",
      updatedAt: alias.updatedAt
    });
    first.close();
    databases.splice(databases.indexOf(first), 1);

    const reopened = track(openVNextDatabase(databasePath));
    expect(await new SqliteConversationAliasRepository(reopened).get(alias.alias)).toEqual(alias);
    expect(await new SqliteChannelMessageRegistryRepository(reopened).getByChannelMessage({
      channel: "weixin",
      channelAccountId: "weixin:personal" as never,
      peerId: "peer-1",
      channelMessageId: "provider-1"
    })).toMatchObject({ sourceAlias: "#C7K2", gatewayMessageId: "delivery-1" });
    expect(await new SqliteActiveConversationRepository(reopened).get({
      channel: "weixin",
      channelAccountId: "weixin:personal" as never,
      peerId: "peer-1"
    })).toMatchObject({ conversationAlias: "#C7K2", updatedBy: "explicit_switch" });
  });

  it("migrates routing rows across databases without overwriting newer target data", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omniagent-routing-migration-"));
    directories.push(directory);
    const source = track(openVNextDatabase(path.join(directory, "runtime-vnext.db")));
    const target = track(openVNextDatabase(path.join(directory, "source-routing.sqlite")));
    const sourceAliases = new SqliteConversationAliasRepository(source);
    const sourceRegistry = new SqliteChannelMessageRegistryRepository(source);
    const sourceActive = new SqliteActiveConversationRepository(source);
    const targetAliases = new SqliteConversationAliasRepository(target);
    const targetRegistry = new SqliteChannelMessageRegistryRepository(target);
    const targetActive = new SqliteActiveConversationRepository(target);
    const oldAlias = {
      alias: "#A111",
      provider: "codex",
      instanceId: null,
      sourceConversationId: "thread-old",
      projectId: "project-old",
      projectName: "old-project",
      taskId: "task-old",
      taskTitle: "旧任务",
      capability: "interactive" as const,
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:01.000Z"
    };
    const oldScope = {
      channel: "weixin" as const,
      channelAccountId: "weixin:personal" as never,
      peerId: "peer-old"
    };
    await sourceAliases.save(oldAlias);
    await sourceRegistry.save({
      registryId: "registry-old",
      ...oldScope,
      channelMessageId: "provider-old",
      gatewayMessageId: "delivery-old",
      provider: "codex",
      sourceConversationId: oldAlias.sourceConversationId,
      sourceAlias: oldAlias.alias,
      taskId: oldAlias.taskId,
      capability: "interactive",
      direction: "outbound",
      createdAt: oldAlias.updatedAt
    });
    await sourceActive.save({
      ...oldScope,
      conversationAlias: oldAlias.alias,
      sourceConversationId: oldAlias.sourceConversationId,
      updatedBy: "explicit_switch",
      updatedAt: oldAlias.updatedAt
    });

    migrateSourceRoutingData(source, target);

    expect(await targetAliases.get(oldAlias.alias)).toEqual(oldAlias);
    expect(await targetRegistry.getByChannelMessage({
      ...oldScope,
      channelMessageId: "provider-old"
    })).toMatchObject({ gatewayMessageId: "delivery-old", sourceAlias: oldAlias.alias });
    expect(await targetActive.get(oldScope)).toMatchObject({
      conversationAlias: oldAlias.alias,
      updatedBy: "explicit_switch"
    });

    await targetAliases.save({
      ...oldAlias,
      projectName: "new-project",
      taskTitle: "新任务",
      updatedAt: "2026-08-13T00:01:00.000Z"
    });
    await targetRegistry.save({
      registryId: "registry-newer",
      ...oldScope,
      channelMessageId: "provider-old",
      gatewayMessageId: "delivery-newer",
      provider: "codex",
      sourceConversationId: oldAlias.sourceConversationId,
      sourceAlias: oldAlias.alias,
      taskId: "task-newer",
      capability: "interactive",
      direction: "outbound",
      createdAt: "2026-08-13T00:01:00.000Z"
    });
    await targetActive.save({
      ...oldScope,
      conversationAlias: oldAlias.alias,
      sourceConversationId: oldAlias.sourceConversationId,
      updatedBy: "admin",
      updatedAt: "2026-08-13T00:01:00.000Z"
    });

    const newAlias = {
      alias: "#A222",
      provider: "claude",
      instanceId: "claude-main",
      sourceConversationId: "thread-new",
      projectId: null,
      projectName: "new-source-project",
      taskId: "task-new",
      taskTitle: "新来源任务",
      capability: "push_only" as const,
      createdAt: "2026-08-13T00:02:00.000Z",
      updatedAt: "2026-08-13T00:02:00.000Z"
    };
    const newScope = {
      channel: "qq" as const,
      channelAccountId: "qq:bot" as never,
      peerId: "peer-new"
    };
    await sourceAliases.save(newAlias);
    await sourceRegistry.save({
      registryId: "registry-new",
      ...newScope,
      channelMessageId: "provider-new",
      gatewayMessageId: "delivery-new",
      provider: "claude",
      sourceConversationId: newAlias.sourceConversationId,
      sourceAlias: newAlias.alias,
      taskId: newAlias.taskId,
      capability: "push_only",
      direction: "outbound",
      createdAt: newAlias.createdAt
    });
    await sourceActive.save({
      ...newScope,
      conversationAlias: newAlias.alias,
      sourceConversationId: newAlias.sourceConversationId,
      updatedBy: "admin",
      updatedAt: newAlias.updatedAt
    });

    migrateSourceRoutingData(source, target);

    expect(await targetAliases.get(oldAlias.alias)).toMatchObject({
      projectName: "new-project",
      taskTitle: "新任务",
      updatedAt: "2026-08-13T00:01:00.000Z"
    });
    expect(await targetRegistry.getByChannelMessage({
      ...oldScope,
      channelMessageId: "provider-old"
    })).toMatchObject({ gatewayMessageId: "delivery-newer", taskId: "task-newer" });
    expect(await targetActive.get(oldScope)).toMatchObject({ updatedBy: "admin", updatedAt: "2026-08-13T00:01:00.000Z" });
    expect(await targetAliases.get(newAlias.alias)).toEqual(newAlias);
    expect(await targetRegistry.getByChannelMessage({
      ...newScope,
      channelMessageId: "provider-new"
    })).toMatchObject({ gatewayMessageId: "delivery-new", sourceAlias: newAlias.alias });
    expect(await targetActive.get(newScope)).toMatchObject({ conversationAlias: newAlias.alias });
  });

  function track(database: SqliteDatabase): SqliteDatabase {
    databases.push(database);
    return database;
  }
});
