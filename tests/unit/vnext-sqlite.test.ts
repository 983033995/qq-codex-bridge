import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SqliteConversationSpaceRepository,
  SqliteThreadBindingRepository,
  applyMigrations,
  openVNextDatabase,
  schemaMigrations,
  type SchemaMigration,
  type SqliteDatabase
} from "../../packages/store-sqlite/src/index.js";
import {
  sampleBinding,
  sampleSpace
} from "../contract/support/vnext-repository-contracts.js";

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
      { version: 1, name: "vnext_core" }
    ]);

    applyMigrations(db, schemaMigrations);
    expect(db.prepare("SELECT count(*) AS count FROM schema_migrations").get()).toEqual({ count: 1 });
  });

  it("rolls back every statement and version record from a failed migration", () => {
    const db = openFileDatabase();
    const broken: SchemaMigration = {
      version: 2,
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
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 2").get()).toBeUndefined();
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
