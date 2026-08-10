import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { schemaMigrations, type SchemaMigration } from "./migrations.js";

export type SqliteRunResult = {
  changes: number;
  lastInsertRowid: number | bigint;
};

export type SqliteStatement = {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): SqliteRunResult;
};

export type SqliteDatabase = {
  exec(sql: string): void;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  prepare(sql: string): SqliteStatement;
  transaction<T>(work: () => T): {
    (): T;
    immediate(): T;
  };
  close(): void;
};

type DatabaseConstructor = new (
  filePath: string,
  options?: { timeout?: number }
) => SqliteDatabase;

const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3") as DatabaseConstructor;

export function openVNextDatabase(
  filePath: string,
  options: { busyTimeoutMs?: number; migrations?: readonly SchemaMigration[] } = {}
): SqliteDatabase {
  if (filePath !== ":memory:") {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  }
  const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
  const db = new BetterSqlite3(filePath, { timeout: busyTimeoutMs });
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    applyMigrations(db, options.migrations ?? schemaMigrations);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function applyMigrations(
  db: SqliteDatabase,
  migrations: readonly SchemaMigration[] = schemaMigrations
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>)
      .map((row) => row.version)
  );
  for (const migration of [...migrations].sort((left, right) => left.version - right.version)) {
    if (applied.has(migration.version)) {
      continue;
    }
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
      ).run(migration.version, migration.name, new Date().toISOString());
    }).immediate();
  }
}
