import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { CodexLocalRolloutReader } from "../../packages/adapters/codex-desktop/src/codex-local-rollout-reader.js";

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

describe("codex local rollout reader", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("captures a cursor from the local threads index and reads commentary plus final reply from rollout jsonl", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-local-rollout-"));
    tempDirs.push(rootDir);

    const codexHomeDir = path.join(rootDir, ".codex");
    const sessionsDir = path.join(codexHomeDir, "sessions", "2026", "04", "19");
    fs.mkdirSync(sessionsDir, { recursive: true });

    const rolloutPath = path.join(sessionsDir, "rollout-thread-a.jsonl");
    fs.writeFileSync(
      rolloutPath,
      `${JSON.stringify({
        timestamp: "2026-04-19T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "thread-a",
          title: "线程 A"
        }
      })}\n`,
      "utf8"
    );

    const dbPath = path.join(codexHomeDir, "state_5.sqlite");
    const db = new BetterSqlite3(dbPath);
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT,
        title TEXT,
        archived INTEGER,
        updated_at_ms INTEGER
      );
    `);
    db.prepare(
      `INSERT INTO threads (id, rollout_path, title, archived, updated_at_ms)
       VALUES (?, ?, ?, ?, ?)`
    ).run("thread-a", rolloutPath, "线程 A", 0, 1776592800000);
    db.close();

    const reader = new CodexLocalRolloutReader({
      codexHomeDir,
      sleep: async () => undefined
    });

    const cursor = reader.captureCursorForThreadTitle("线程 A");
    expect(cursor).toMatchObject({
      threadId: "thread-a",
      rolloutPath
    });
    expect(cursor?.lineCount).toBe(1);

    fs.appendFileSync(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: "2026-04-19T10:00:03.000Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            phase: "commentary",
            message: "我先查一下本地线程索引。"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-19T10:00:08.000Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn-123",
            last_agent_message:
              "最终结论如下：\n<qqmedia>/tmp/final-image.png</qqmedia>"
          }
        })
      ].join("\n") + "\n",
      "utf8"
    );

    const result = await reader.waitForTurnCompletion(cursor!, {
      pollAttempts: 1,
      pollIntervalMs: 0
    });

    expect(result).toMatchObject({
      turnId: "turn-123",
      commentaryMessages: ["我先查一下本地线程索引。"],
      finalText: "最终结论如下：\n<qqmedia>/tmp/final-image.png</qqmedia>",
      fullText:
        "我先查一下本地线程索引。\n最终结论如下：\n<qqmedia>/tmp/final-image.png</qqmedia>",
      mediaReferences: ["/tmp/final-image.png"]
    });
  });

  it("locks onto the first started turn after the cursor and ignores later turn completions from the same thread", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-local-rollout-"));
    tempDirs.push(rootDir);

    const codexHomeDir = path.join(rootDir, ".codex");
    const sessionsDir = path.join(codexHomeDir, "sessions", "2026", "04", "19");
    fs.mkdirSync(sessionsDir, { recursive: true });

    const rolloutPath = path.join(sessionsDir, "rollout-thread-b.jsonl");
    fs.writeFileSync(
      rolloutPath,
      `${JSON.stringify({
        timestamp: "2026-04-19T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "thread-b",
          title: "线程 B"
        }
      })}\n`,
      "utf8"
    );

    const dbPath = path.join(codexHomeDir, "state_5.sqlite");
    const db = new BetterSqlite3(dbPath);
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT,
        title TEXT,
        archived INTEGER,
        updated_at_ms INTEGER
      );
    `);
    db.prepare(
      `INSERT INTO threads (id, rollout_path, title, archived, updated_at_ms)
       VALUES (?, ?, ?, ?, ?)`
    ).run("thread-b", rolloutPath, "线程 B", 0, 1776592800000);
    db.close();

    const reader = new CodexLocalRolloutReader({
      codexHomeDir,
      sleep: async () => undefined
    });

    const cursor = reader.captureCursorForThreadTitle("线程 B");
    expect(cursor).toMatchObject({
      threadId: "thread-b",
      rolloutPath
    });

    fs.appendFileSync(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: "2026-04-19T10:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-1"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-19T10:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            phase: "commentary",
            message: "先处理第一轮。"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-19T10:00:03.000Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-2"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-19T10:00:04.000Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            phase: "commentary",
            message: "第二轮的 commentary 不该串到第一轮。"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-19T10:00:05.000Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn-1",
            last_agent_message: "第一轮最终结论"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-19T10:00:06.000Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn-2",
            last_agent_message: "第二轮最终结论"
          }
        })
      ].join("\n") + "\n",
      "utf8"
    );

    const result = await reader.waitForTurnCompletion(cursor!, {
      pollAttempts: 1,
      pollIntervalMs: 0
    });

    expect(result).toMatchObject({
      turnId: "turn-1",
      commentaryMessages: ["先处理第一轮。"],
      finalText: "第一轮最终结论",
      fullText: "先处理第一轮。\n第一轮最终结论",
      mediaReferences: []
    });
  });
});
