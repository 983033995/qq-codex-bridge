import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3") as new (filePath: string) => SqliteDatabase;

export type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  };
  close(): void;
};

export function createSqliteDatabase(filePath: string): SqliteDatabase {
  if (filePath !== ":memory:") {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  const db = new BetterSqlite3(filePath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS bridge_sessions (
      session_key TEXT PRIMARY KEY,
      account_key TEXT NOT NULL,
      peer_key TEXT NOT NULL,
      chat_type TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      codex_thread_ref TEXT,
      status TEXT NOT NULL,
      last_inbound_at TEXT,
      last_outbound_at TEXT,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS message_ledger (
      message_id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      direction TEXT NOT NULL,
      qq_message_ref TEXT,
      codex_turn_ref TEXT,
      content_digest TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS delivery_jobs (
      job_id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_locks (
      session_key TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      locked_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);

  return db;
}
