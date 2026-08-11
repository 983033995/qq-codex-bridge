import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SqliteConversationSpaceRepository,
  SqliteMessageLedger,
  SqliteThreadBindingRepository,
  SqliteTurnRepository,
  applyMigrations,
  openVNextDatabase,
  schemaMigrations,
  type SchemaMigration,
  type SqliteDatabase
} from "../../packages/store-sqlite/src/index.js";
import {
  sampleBinding,
  sampleMessage,
  sampleSpace
} from "../contract/support/vnext-repository-contracts.js";
import type { Turn } from "../../packages/domain/src/vnext/index.js";

describe("vNext SQLite database", () => {
  const temporaryDirectories: string[] = [];
  const openDatabases: SqliteDatabase[] = [];

  afterEach(() => {
    for (const db of openDatabases.splice(0).reverse()) {
      db.close();
    }
    for (const directory of temporaryDirectories.splice(0).reverse()) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("enables WAL, foreign keys, busy timeout, and applies the schema once", () => {
    const db = openFileDatabase(1234);

    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("busy_timeout", { simple: true })).toBe(1234);
    expect(db.prepare("SELECT version, name FROM schema_migrations").all()).toEqual([
      { version: 1, name: "vnext_core" },
      { version: 2, name: "turn_unknown_recovery_status" },
      { version: 3, name: "delivery_retry_recovery" }
    ]);

    applyMigrations(db, schemaMigrations);
    expect(db.prepare("SELECT count(*) AS count FROM schema_migrations").get()).toEqual({ count: 3 });
  });

  it("migrates v1 Turn rows without loss and accepts the unknown recovery status", () => {
    const directory = createTemporaryDirectory();
    const databasePath = path.join(directory, "runtime-vnext.db");
    const first = track(openVNextDatabase(databasePath, { migrations: [schemaMigrations[0]!] }));
    const space = sampleSpace("migration");
    first.prepare(`
      INSERT INTO conversation_spaces (
        space_id, channel, account_id, provider_conversation_id, scope,
        display_name, status, last_inbound_at, last_outbound_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(
      space.spaceId,
      space.channel,
      space.accountId,
      space.providerConversationId,
      space.scope,
      space.displayName,
      space.status
    );
    first.prepare(`
      INSERT INTO messages (
        message_id, provider_message_id, space_id, sender_id, received_sequence,
        direction, content_json, dedupe_key, status, created_at
      ) VALUES ('message-migration', 'provider-migration', ?, 'sender', 1,
        'inbound', '{}', 'dedupe-migration', 'accepted', '2026-08-10T06:00:00.000Z')
    `).run(space.spaceId);
    first.prepare(`
      INSERT INTO turns (
        turn_id, thread_id, space_id, inbound_message_id, status, transport,
        error_code, queued_at, started_at, completed_at
      ) VALUES ('turn-migration', 'thread-migration', ?, 'message-migration', 'running',
        'app-server', NULL, '2026-08-10T06:00:00.000Z',
        '2026-08-10T06:00:01.000Z', NULL)
    `).run(space.spaceId);
    first.prepare(`
      INSERT INTO deliveries (
        delivery_id, delivery_key, space_id, status, provider_message_id,
        attempts, error_code, created_at, updated_at
      ) VALUES ('delivery-v2', 'delivery-key-v2', ?, 'retry_wait', NULL,
        1, 'CHANNEL_DELIVERY_FAILED', '2026-08-10T06:00:00.000Z', '2026-08-10T06:00:02.000Z')
    `).run(space.spaceId);
    first.close();
    openDatabases.splice(openDatabases.indexOf(first), 1);

    const migrated = track(openVNextDatabase(databasePath));
    expect(migrated.prepare("SELECT status FROM turns WHERE turn_id = 'turn-migration'").get())
      .toEqual({ status: "running" });
    expect(() => migrated.prepare(
      "UPDATE turns SET status = 'unknown' WHERE turn_id = 'turn-migration'"
    ).run()).not.toThrow();
    expect(migrated.prepare("SELECT status FROM turns WHERE turn_id = 'turn-migration'").get())
      .toEqual({ status: "unknown" });
    expect(migrated.prepare("SELECT status, error_code FROM deliveries WHERE delivery_id = 'delivery-v2'").get())
      .toEqual({ status: "failed", error_code: "CHANNEL_DELIVERY_FAILED" });
  });

  it("rolls back every statement and version record from a failed migration", () => {
    const db = openFileDatabase();
    const broken: SchemaMigration = {
      version: 4,
      name: "broken_migration",
      sql: `
        CREATE TABLE must_rollback (id TEXT PRIMARY KEY) STRICT;
        INSERT INTO missing_table (id) VALUES ('boom');
      `
    };

    expect(() => applyMigrations(db, [...schemaMigrations, broken])).toThrow("missing_table");
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'must_rollback'"
    ).get()).toBeUndefined();
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 4").get()).toBeUndefined();
  });

  it("rolls back application writes when an IMMEDIATE transaction fails", () => {
    const db = openFileDatabase();
    const space = sampleSpace("rollback");

    expect(() => db.transaction(() => {
      db.prepare(`
        INSERT INTO conversation_spaces (
          space_id, channel, account_id, provider_conversation_id, scope,
          display_name, status, last_inbound_at, last_outbound_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      `).run(
        space.spaceId,
        space.channel,
        space.accountId,
        space.providerConversationId,
        space.scope,
        space.displayName,
        space.status
      );
      throw new Error("crash during transaction");
    }).immediate()).toThrow("crash during transaction");
    expect(db.prepare("SELECT * FROM conversation_spaces WHERE space_id = ?").get(space.spaceId))
      .toBeUndefined();
  });

  it("restores active bindings after closing and reopening runtime-vnext.db", async () => {
    const directory = createTemporaryDirectory();
    const databasePath = path.join(directory, "runtime-vnext.db");
    const first = track(openVNextDatabase(databasePath));
    const space = sampleSpace("persistent");
    const binding = sampleBinding("binding-persistent", space, "thread-persistent");
    await new SqliteConversationSpaceRepository(first).save(space);
    await new SqliteThreadBindingRepository(first).save(binding);
    first.close();
    openDatabases.splice(openDatabases.indexOf(first), 1);

    const reopened = track(openVNextDatabase(databasePath));
    expect(await new SqliteThreadBindingRepository(reopened).getActiveBySpace(space.spaceId))
      .toEqual(binding);
  });

  it("paginates turns newest-first with a stable id tie-breaker", async () => {
    const db = openFileDatabase();
    const spaces = new SqliteConversationSpaceRepository(db);
    const messages = new SqliteMessageLedger(db);
    const turns = new SqliteTurnRepository(db);
    const space = sampleSpace("turn-page");
    await spaces.save(space);

    for (const [index, turnId] of ["turn-a", "turn-c", "turn-b", "turn-old"].entries()) {
      const queuedAt = turnId === "turn-old"
        ? "2026-08-10T05:59:59.000Z"
        : "2026-08-10T06:00:00.000Z";
      const message = sampleMessage(`message-${turnId}`, space, index + 1, queuedAt);
      await messages.appendInbound(message, `dedupe-${turnId}`);
      await turns.save({
        turnId,
        threadId: "thread-page",
        spaceId: space.spaceId,
        inboundMessageId: message.messageId,
        status: "completed",
        transport: "app-server",
        errorCode: null,
        queuedAt,
        startedAt: queuedAt,
        completedAt: queuedAt
      } satisfies Turn);
    }

    const first = await turns.list({ limit: 2 });
    expect(first.items.map((turn) => turn.turnId)).toEqual(["turn-c", "turn-b"]);
    expect(first.nextCursor).toBeTruthy();

    const second = await turns.list({ limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((turn) => turn.turnId)).toEqual(["turn-a", "turn-old"]);
    expect(second.nextCursor).toBeNull();
    await expect(turns.list({ limit: 2, cursor: "not-json" })).rejects.toThrow();
  });

  it("keeps foreign-key failures distinct from binding conflicts", async () => {
    const db = openFileDatabase();
    const missingSpace = sampleSpace("missing");

    await expect(
      new SqliteThreadBindingRepository(db).save(
        sampleBinding("binding-missing", missingSpace, "thread-missing")
      )
    ).rejects.not.toMatchObject({ code: "BINDING_CONFLICT" });
  });

  it("rejects invalid JSON and foreign-key writes loudly", () => {
    const db = openFileDatabase();
    expect(() => db.prepare(`
      INSERT INTO runtime_events (event_id, component, type, payload_json, created_at)
      VALUES ('event-invalid', 'test', 'invalid', 'not-json', '2026-08-10T06:00:00.000Z')
    `).run()).toThrow(/CHECK constraint failed/i);
    expect(() => db.prepare(`
      INSERT INTO push_jobs (
        push_id, idempotency_key, target_alias, status, content_json,
        attempt_count, next_attempt_at, created_at, updated_at
      ) VALUES (
        'push-invalid', 'key-invalid', 'missing-target', 'queued', '{}',
        0, NULL, '2026-08-10T06:00:00.000Z', '2026-08-10T06:00:00.000Z'
      )
    `).run()).toThrow(/FOREIGN KEY constraint failed/i);
  });

  function openFileDatabase(busyTimeoutMs = 5000): SqliteDatabase {
    const directory = createTemporaryDirectory();
    return track(openVNextDatabase(path.join(directory, "runtime-vnext.db"), { busyTimeoutMs }));
  }

  function createTemporaryDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qq-codex-vnext-sqlite-"));
    temporaryDirectories.push(directory);
    return directory;
  }

  function track(db: SqliteDatabase): SqliteDatabase {
    openDatabases.push(db);
    return db;
  }
});
