import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { parseQqMediaSegments } from "../../qq/src/qq-media-parser.js";

const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3") as new (
  filePath: string,
  options?: { readonly?: boolean; fileMustExist?: boolean }
) => {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
  };
  close(): void;
};

type ThreadRow = {
  threadId: string;
  rolloutPath: string | null;
};

type RolloutEventRecord = {
  type?: string;
  payload?: {
    type?: string;
    turn_id?: string;
    phase?: string;
    message?: string;
    last_agent_message?: string;
  };
};

export type CodexLocalRolloutCursor = {
  threadId: string;
  rolloutPath: string;
  lineCount: number;
  targetTurnId?: string | null;
  competingTurnStarted?: boolean;
};

export type CodexLocalRolloutTurnResult = {
  turnId: string | null;
  commentaryMessages: string[];
  finalText: string;
  fullText: string;
  mediaReferences: string[];
};

type CodexLocalRolloutReaderOptions = {
  codexHomeDir?: string;
  sleep?: (ms: number) => Promise<void>;
};

export class CodexLocalRolloutReader {
  private readonly codexHomeDir: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: CodexLocalRolloutReaderOptions = {}) {
    this.codexHomeDir =
      options.codexHomeDir ??
      process.env.CODEX_HOME ??
      path.join(os.homedir(), ".codex");
    this.sleep =
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  captureCursorForThreadTitle(title: string): CodexLocalRolloutCursor | null {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      return null;
    }

    const thread = this.findLatestThreadByTitle(normalizedTitle);
    if (!thread?.rolloutPath) {
      return null;
    }

    if (!fs.existsSync(thread.rolloutPath)) {
      return null;
    }

    return {
      threadId: thread.threadId,
      rolloutPath: thread.rolloutPath,
      lineCount: countNonEmptyLines(thread.rolloutPath),
      targetTurnId: null,
      competingTurnStarted: false
    };
  }

  async waitForTurnCompletion(
    cursor: CodexLocalRolloutCursor,
    options: {
      pollAttempts: number;
      pollIntervalMs: number;
    }
  ): Promise<CodexLocalRolloutTurnResult | null> {
    let currentCursor = cursor;
    let targetTurnId = cursor.targetTurnId ?? null;
    let competingTurnStarted = cursor.competingTurnStarted ?? false;
    const commentaryMessages: string[] = [];
    const seenCommentaryMessages = new Set<string>();
    let pendingFinalText: string | null = null;

    for (let attempt = 0; attempt < options.pollAttempts; attempt += 1) {
      const { nextCursor, events } = readRolloutEvents(currentCursor);
      currentCursor = {
        ...nextCursor,
        targetTurnId,
        competingTurnStarted
      };

      for (const event of events) {
        if (event.type !== "event_msg" || !event.payload) {
          continue;
        }

        const eventType = event.payload.type;
        const eventTurnId = normalizeTurnId(event.payload.turn_id);

        if (eventType === "task_started" && eventTurnId) {
          if (!targetTurnId) {
            targetTurnId = eventTurnId;
            competingTurnStarted = false;
            currentCursor.targetTurnId = targetTurnId;
            currentCursor.competingTurnStarted = competingTurnStarted;
            continue;
          }

          if (eventTurnId !== targetTurnId) {
            competingTurnStarted = true;
            currentCursor.competingTurnStarted = competingTurnStarted;
          }
          continue;
        }

        if (
          eventType === "agent_message"
          && event.payload.phase === "commentary"
          && typeof event.payload.message === "string"
        ) {
          if (!shouldCollectTurnScopedMessage(eventTurnId, targetTurnId, competingTurnStarted)) {
            continue;
          }
          const commentary = event.payload.message.trim();
          if (commentary && !seenCommentaryMessages.has(commentary)) {
            commentaryMessages.push(commentary);
            seenCommentaryMessages.add(commentary);
          }
          continue;
        }

        if (
          eventType === "agent_message"
          && event.payload.phase === "final_answer"
          && typeof event.payload.message === "string"
        ) {
          if (!shouldCollectTurnScopedMessage(eventTurnId, targetTurnId, competingTurnStarted)) {
            continue;
          }
          const finalAnswer = event.payload.message.trim();
          if (finalAnswer) {
            pendingFinalText = finalAnswer;
          }
          continue;
        }

        if (eventType === "task_complete") {
          if (targetTurnId && eventTurnId && eventTurnId !== targetTurnId) {
            continue;
          }
          const finalText = normalizeFinalText(
            event.payload.last_agent_message,
            pendingFinalText
          );
          if (!finalText) {
            continue;
          }

          if (!targetTurnId) {
            targetTurnId = eventTurnId;
          }

          const fullText = joinMessageParts(commentaryMessages, finalText);
          return {
            turnId: targetTurnId,
            commentaryMessages,
            finalText,
            fullText,
            mediaReferences: extractMediaReferences(fullText)
          };
        }
      }

      if (attempt + 1 < options.pollAttempts) {
        await this.sleep(options.pollIntervalMs);
      }
    }

    return null;
  }

  private findLatestThreadByTitle(title: string): ThreadRow | null {
    const stateDbPath = path.join(this.codexHomeDir, "state_5.sqlite");
    if (!fs.existsSync(stateDbPath)) {
      return null;
    }

    let db: InstanceType<typeof BetterSqlite3> | null = null;
    try {
      db = new BetterSqlite3(stateDbPath, {
        readonly: true,
        fileMustExist: true
      });

      const row = db
        .prepare(
          `SELECT id AS threadId, rollout_path AS rolloutPath
           FROM threads
           WHERE archived = 0
             AND title = ?
             AND rollout_path IS NOT NULL
           ORDER BY updated_at_ms DESC
           LIMIT 1`
        )
        .get(title) as ThreadRow | undefined;

      return row ?? null;
    } catch {
      return null;
    } finally {
      db?.close();
    }
  }
}

function readRolloutEvents(cursor: CodexLocalRolloutCursor): {
  nextCursor: CodexLocalRolloutCursor;
  events: RolloutEventRecord[];
} {
  if (!fs.existsSync(cursor.rolloutPath)) {
    return {
      nextCursor: cursor,
      events: []
    };
  }

  const contents = fs.readFileSync(cursor.rolloutPath, "utf8");
  const lines = splitNonEmptyLines(contents);
  const safeOffset = Math.min(cursor.lineCount, lines.length);
  const newLines = lines.slice(safeOffset);
  const events = newLines.flatMap((line) => {
    try {
      return [JSON.parse(line) as RolloutEventRecord];
    } catch {
      return [];
    }
  });

  return {
    nextCursor: {
      ...cursor,
      lineCount: lines.length
    },
    events
  };
}

function countNonEmptyLines(filePath: string): number {
  if (!fs.existsSync(filePath)) {
    return 0;
  }

  return splitNonEmptyLines(fs.readFileSync(filePath, "utf8")).length;
}

function splitNonEmptyLines(contents: string): string[] {
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function normalizeFinalText(lastAgentMessage: string | undefined, pendingFinalText: string | null): string {
  if (typeof lastAgentMessage === "string" && lastAgentMessage.trim()) {
    return lastAgentMessage.trim();
  }

  return pendingFinalText?.trim() ?? "";
}

function normalizeTurnId(turnId: string | undefined): string | null {
  if (typeof turnId !== "string") {
    return null;
  }

  const normalized = turnId.trim();
  return normalized ? normalized : null;
}

function shouldCollectTurnScopedMessage(
  eventTurnId: string | null,
  targetTurnId: string | null,
  competingTurnStarted: boolean
): boolean {
  if (!targetTurnId) {
    return true;
  }

  if (eventTurnId) {
    return eventTurnId === targetTurnId;
  }

  return !competingTurnStarted;
}

function joinMessageParts(commentaryMessages: string[], finalText: string): string {
  return [...commentaryMessages, finalText]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
}

function extractMediaReferences(text: string): string[] {
  return parseQqMediaSegments(text)
    .filter((segment) => segment.type === "media")
    .map((segment) => segment.reference);
}
