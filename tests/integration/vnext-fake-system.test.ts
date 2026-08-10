import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BindConversationSpace,
  ReceiveInboundMessage,
  StartConversationTurn,
  ThreadSerialExecutor
} from "../../packages/application/src/index.js";
import type {
  ChannelName,
  ConversationSpace,
  InboundEnvelope,
  ThreadBinding
} from "../../packages/domain/src/vnext/index.js";
import {
  SqliteConversationSpaceRepository,
  SqliteMessageLedger,
  SqliteThreadBindingRepository,
  SqliteTurnRepository,
  openVNextDatabase,
  type SqliteDatabase
} from "../../packages/store-sqlite/src/index.js";
import {
  ControllableCodexPort,
  FixedClock,
  SequenceIdGenerator
} from "../support/vnext-fakes.js";

describe("M1-07 Fake A/B/C system acceptance", () => {
  const openDatabases: SqliteDatabase[] = [];
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const db of openDatabases.splice(0).reverse()) {
      db.close();
    }
    for (const directory of temporaryDirectories.splice(0).reverse()) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps A/B/C independently bound, runs different threads in parallel, and one thread serially", async () => {
    const db = openDatabase();
    const repositories = createRepositories(db);
    const codex = new ControllableCodexPort(false);
    const clock = new FixedClock();
    const receive = new ReceiveInboundMessage({
      spaces: repositories.spaces,
      messages: repositories.messages
    });
    const bind = new BindConversationSpace({
      spaces: repositories.spaces,
      bindings: repositories.bindings,
      codex,
      ids: new SequenceIdGenerator("binding"),
      clock
    });
    const start = new StartConversationTurn({
      bindings: repositories.bindings,
      turns: repositories.turns,
      codex,
      ids: new SequenceIdGenerator("failed-turn"),
      clock,
      serial: new ThreadSerialExecutor()
    });
    const spaceA = sampleSpace("weixin", "personal", "owner-a", "微信 A");
    const spaceB = sampleSpace("feishu", "bot", "owner-b", "飞书 B");
    const spaceC = sampleSpace("qq", "bot", "owner-c", "QQ C");
    const messageA1 = sampleMessage("message-a1", spaceA, 1);
    const messageA2 = sampleMessage("message-a2", spaceA, 2);
    const messageB1 = sampleMessage("message-b1", spaceB, 1);
    const messageC1 = sampleMessage("message-c1", spaceC, 1);

    for (const [space, message] of [
      [spaceA, messageA1],
      [spaceA, messageA2],
      [spaceB, messageB1],
      [spaceC, messageC1]
    ] as const) {
      await expect(receive.execute({ space, message })).resolves.toMatchObject({
        accepted: true,
        duplicate: false
      });
    }

    const bindingA = await bind.execute({ spaceId: spaceA.spaceId });
    const bindingB = await bind.execute({ spaceId: spaceB.spaceId });
    const bindingC = await bind.execute({ spaceId: spaceC.spaceId });
    expect(new Set([bindingA.threadId, bindingB.threadId, bindingC.threadId]).size).toBe(3);
    expect([bindingA, bindingB, bindingC].map((binding) => binding.mode))
      .toEqual(["exclusive", "exclusive", "exclusive"]);
    expect([bindingA.threadTitle, bindingB.threadTitle, bindingC.threadTitle]).toEqual([
      "微信 · 微信 A",
      "飞书 · 飞书 B",
      "QQ · QQ C"
    ]);

    const executionA1 = start.execute(messageA1);
    const executionA2 = start.execute(messageA2);
    const executionB1 = start.execute(messageB1);
    const executionC1 = start.execute(messageC1);
    await codex.waitForStartCount(3);
    expect(codex.starts.map((started) => started.input.idempotencyKey).sort()).toEqual([
      "message-a1",
      "message-b1",
      "message-c1"
    ]);

    const firstA = codex.starts.find(
      (started) => started.input.idempotencyKey === messageA1.messageId
    )!;
    codex.complete(firstA.handle.turnId);
    await codex.waitForStartCount(4);
    expect(codex.starts[3]?.input.idempotencyKey).toBe(messageA2.messageId);

    for (const started of codex.starts.filter((candidate) => candidate !== firstA)) {
      codex.complete(started.handle.turnId);
    }
    const results = await Promise.all([executionA1, executionA2, executionB1, executionC1]);
    expect(results.map((result) => result.turn.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed"
    ]);
    expect(await repositories.turns.listActiveByThread(bindingA.threadId)).toEqual([]);
  });

  it("restores bindings after Store restart and rolls back an exclusive conflict", async () => {
    const directory = createTemporaryDirectory();
    const databasePath = path.join(directory, "runtime-vnext.db");
    const codex = new ControllableCodexPort();
    const clock = new FixedClock();
    const firstDb = track(openVNextDatabase(databasePath));
    const first = createRepositories(firstDb);
    const spaceA = sampleSpace("weixin", "personal", "owner-a", "A");
    const spaceB = sampleSpace("feishu", "bot", "owner-b", "B");
    await first.spaces.save(spaceA);
    await first.spaces.save(spaceB);
    const firstBind = new BindConversationSpace({
      spaces: first.spaces,
      bindings: first.bindings,
      codex,
      ids: new SequenceIdGenerator("binding"),
      clock
    });
    const bindingA = await firstBind.execute({ spaceId: spaceA.spaceId });
    const bindingB = await firstBind.execute({ spaceId: spaceB.spaceId });
    firstDb.close();
    openDatabases.splice(openDatabases.indexOf(firstDb), 1);

    const reopenedDb = track(openVNextDatabase(databasePath));
    const reopened = createRepositories(reopenedDb);
    expect(await reopened.bindings.getActiveBySpace(spaceA.spaceId)).toEqual(bindingA);
    expect(await reopened.bindings.getActiveBySpace(spaceB.spaceId)).toEqual(bindingB);

    const threadA = (await codex.listThreads({ limit: 10 }))
      .find((thread) => thread.threadId === bindingA.threadId)!;
    const rebound = new BindConversationSpace({
      spaces: reopened.spaces,
      bindings: reopened.bindings,
      codex,
      ids: new SequenceIdGenerator("rebind"),
      clock
    });
    await expect(rebound.execute({
      spaceId: spaceB.spaceId,
      thread: threadA,
      replaceActive: true
    })).rejects.toMatchObject({ code: "BINDING_CONFLICT" });

    expect(await reopened.bindings.getActiveBySpace(spaceA.spaceId)).toEqual(bindingA);
    expect(await reopened.bindings.getActiveBySpace(spaceB.spaceId)).toEqual(bindingB);
  });

  function openDatabase(): SqliteDatabase {
    const directory = createTemporaryDirectory();
    return track(openVNextDatabase(path.join(directory, "runtime-vnext.db")));
  }

  function createTemporaryDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qq-codex-vnext-fake-system-"));
    temporaryDirectories.push(directory);
    return directory;
  }

  function track(db: SqliteDatabase): SqliteDatabase {
    openDatabases.push(db);
    return db;
  }
});

function createRepositories(db: SqliteDatabase): {
  spaces: SqliteConversationSpaceRepository;
  bindings: SqliteThreadBindingRepository;
  messages: SqliteMessageLedger;
  turns: SqliteTurnRepository;
} {
  return {
    spaces: new SqliteConversationSpaceRepository(db),
    bindings: new SqliteThreadBindingRepository(db),
    messages: new SqliteMessageLedger(db),
    turns: new SqliteTurnRepository(db)
  };
}

function sampleSpace(
  channel: ChannelName,
  account: string,
  providerConversationId: string,
  displayName: string
): ConversationSpace {
  const accountId = `${channel}:${account}` as ConversationSpace["accountId"];
  return {
    spaceId: `${accountId}::c2c:${providerConversationId}` as ConversationSpace["spaceId"],
    channel,
    accountId,
    providerConversationId,
    scope: "c2c",
    displayName,
    status: "active",
    lastInboundAt: null,
    lastOutboundAt: null
  };
}

function sampleMessage(
  messageId: string,
  space: ConversationSpace,
  receivedSequence: number
): InboundEnvelope {
  return {
    messageId,
    providerMessageId: `provider-${messageId}`,
    spaceId: space.spaceId,
    senderId: `sender-${space.providerConversationId}`,
    receivedSequence,
    receivedAt: `2026-08-10T06:00:0${receivedSequence}.000Z`,
    content: { text: messageId, mentions: [], attachments: [] }
  };
}
