import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3") as new (
  filePath: string,
  options?: { readonly?: boolean; fileMustExist?: boolean }
) => {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
};

type SubmissionLogRow = {
  id: number;
  target: string;
  feedbackLogBody: string | null;
  threadId: string | null;
};

export type CodexLocalSubmissionCursor = {
  threadId: string;
  lastLogId: number;
};

export type CodexLocalSubmissionResult = {
  submitted: boolean;
  turnId: string | null;
  reason: string;
};

type CodexLocalSubmissionReaderOptions = {
  codexHomeDir?: string;
  sleep?: (ms: number) => Promise<void>;
};

export class CodexLocalSubmissionReader {
  private readonly codexHomeDir: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: CodexLocalSubmissionReaderOptions = {}) {
    this.codexHomeDir =
      options.codexHomeDir ??
      process.env.CODEX_HOME ??
      path.join(os.homedir(), ".codex");
    this.sleep =
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  captureCursorForThreadId(threadId: string): CodexLocalSubmissionCursor | null {
    const normalizedThreadId = normalizeThreadId(threadId);
    if (!normalizedThreadId) {
      return null;
    }

    const dbPath = this.resolveLogsDbPath();
    if (!dbPath) {
      return null;
    }

    let db: InstanceType<typeof BetterSqlite3> | null = null;
    try {
      db = new BetterSqlite3(dbPath, {
        readonly: true,
        fileMustExist: true
      });

      const row = db
        .prepare("SELECT MAX(id) AS lastLogId FROM logs")
        .get() as { lastLogId?: number | null } | undefined;

      return {
        threadId: normalizedThreadId,
        lastLogId: Number(row?.lastLogId ?? 0)
      };
    } catch {
      return null;
    } finally {
      db?.close();
    }
  }

  async waitForTurnSubmission(
    cursor: CodexLocalSubmissionCursor,
    options: {
      pollAttempts: number;
      pollIntervalMs: number;
    }
  ): Promise<CodexLocalSubmissionResult> {
    const dbPath = this.resolveLogsDbPath();
    if (!dbPath) {
      return {
        submitted: false,
        turnId: null,
        reason: "logs_db_missing"
      };
    }

    for (let attempt = 0; attempt < options.pollAttempts; attempt += 1) {
      const submission = readSubmissionSince(dbPath, cursor);
      if (submission) {
        return submission;
      }

      if (attempt + 1 < options.pollAttempts) {
        await this.sleep(options.pollIntervalMs);
      }
    }

    return {
      submitted: false,
      turnId: null,
      reason: "submission_dispatch_not_observed"
    };
  }

  private resolveLogsDbPath(): string | null {
    const dbPath = path.join(this.codexHomeDir, "logs_2.sqlite");
    return fs.existsSync(dbPath) ? dbPath : null;
  }
}

function readSubmissionSince(
  dbPath: string,
  cursor: CodexLocalSubmissionCursor
): CodexLocalSubmissionResult | null {
  let db: InstanceType<typeof BetterSqlite3> | null = null;
  try {
    db = new BetterSqlite3(dbPath, {
      readonly: true,
      fileMustExist: true
    });

    const rows = db
      .prepare(
        `SELECT id, target, feedback_log_body AS feedbackLogBody, thread_id AS threadId
         FROM logs
         WHERE id > ?
         ORDER BY id ASC`
      )
      .all(cursor.lastLogId) as SubmissionLogRow[];

    if (rows.length === 0) {
      return null;
    }

    cursor.lastLogId = rows.at(-1)?.id ?? cursor.lastLogId;

    for (const row of rows) {
      if (row.target !== "codex_client::transport") {
        continue;
      }

      const body = typeof row.feedbackLogBody === "string" ? row.feedbackLogBody : "";
      if (!body.includes("submission_dispatch")) {
        continue;
      }

      if (!matchesSubmissionThread(row.threadId, body, cursor.threadId)) {
        continue;
      }

      return {
        submitted: true,
        turnId: extractTurnId(body),
        reason: "submission_dispatch_logged"
      };
    }

    return null;
  } catch {
    return {
      submitted: false,
      turnId: null,
      reason: "logs_db_unreadable"
    };
  } finally {
    db?.close();
  }
}

function matchesSubmissionThread(
  rowThreadId: string | null,
  body: string,
  expectedThreadId: string
): boolean {
  if (rowThreadId === expectedThreadId) {
    return true;
  }

  return body.includes(`thread.id=${expectedThreadId}`) || body.includes(`thread_id=${expectedThreadId}`);
}

function extractTurnId(body: string): string | null {
  const match = body.match(/turn(?:\.id|_id)=([^\s}]+)/);
  if (!match?.[1]) {
    return null;
  }

  const turnId = match[1].trim();
  return turnId ? turnId : null;
}

function normalizeThreadId(threadId: string): string | null {
  const normalized = threadId.trim();
  return normalized ? normalized : null;
}
