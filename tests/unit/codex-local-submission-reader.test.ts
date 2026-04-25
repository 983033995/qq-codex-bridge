import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { CodexLocalSubmissionReader } from "../../packages/adapters/codex-desktop/src/codex-local-submission-reader.js";

const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3") as new (
  filePath: string
) => {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
  };
  close(): void;
};

describe("codex local submission reader", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("captures a log cursor and confirms submission from codex transport logs", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-local-submission-"));
    tempDirs.push(rootDir);

    const codexHomeDir = path.join(rootDir, ".codex");
    fs.mkdirSync(codexHomeDir, { recursive: true });

    const dbPath = path.join(codexHomeDir, "logs_2.sqlite");
    const db = new BetterSqlite3(dbPath);
    db.exec(`
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        ts_nanos INTEGER NOT NULL,
        level TEXT NOT NULL,
        target TEXT NOT NULL,
        feedback_log_body TEXT,
        module_path TEXT,
        file TEXT,
        line INTEGER,
        thread_id TEXT,
        process_uuid TEXT,
        estimated_bytes INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.prepare(
      `INSERT INTO logs (
        ts, ts_nanos, level, target, feedback_log_body, module_path, file, line,
        thread_id, process_uuid, estimated_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      1776611657,
      0,
      "TRACE",
      "codex_app_server::outgoing_message",
      "app-server event: item/completed targeted_connections=1",
      null,
      null,
      null,
      null,
      "pid:1:test",
      0
    );
    db.close();

    const reader = new CodexLocalSubmissionReader({
      codexHomeDir,
      sleep: async () => undefined
    });

    const cursor = reader.captureCursorForThreadId("thread-local-1");
    expect(cursor).toMatchObject({
      threadId: "thread-local-1"
    });

    const db2 = new BetterSqlite3(dbPath);
    db2.prepare(
      `INSERT INTO logs (
        ts, ts_nanos, level, target, feedback_log_body, module_path, file, line,
        thread_id, process_uuid, estimated_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      1776611658,
      0,
      "INFO",
      "codex_client::transport",
      'session_loop{thread_id=thread-local-1}:submission_dispatch{otel.name="op.dispatch.user_input" submission.id="sub-1" codex.op="user_input"}:turn{otel.name="session_task.turn" thread.id=thread-local-1 turn.id=turn-local-123 model=gpt-5.4}',
      null,
      null,
      null,
      "thread-local-1",
      "pid:1:test",
      0
    );
    db2.close();

    const result = await reader.waitForTurnSubmission(cursor!, {
      pollAttempts: 1,
      pollIntervalMs: 0
    });

    expect(result).toEqual({
      submitted: true,
      turnId: "turn-local-123",
      reason: "submission_dispatch_logged"
    });
  });
});
