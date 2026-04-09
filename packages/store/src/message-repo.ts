import { createHash } from "node:crypto";
import type { ConversationEntry, InboundMessage, OutboundDraft } from "../../domain/src/message.js";
import type { TranscriptStorePort } from "../../ports/src/store.js";
import type { SqliteDatabase } from "./sqlite.js";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class SqliteTranscriptStore implements TranscriptStorePort {
  constructor(private readonly db: SqliteDatabase) {}

  async recordInbound(message: InboundMessage): Promise<void> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO message_ledger (
          message_id, session_key, direction, qq_message_ref, codex_turn_ref,
          content_digest, payload_json, created_at
        ) VALUES (?, ?, 'inbound', ?, NULL, ?, ?, ?)`
      )
      .run(
        message.messageId,
        message.sessionKey,
        message.messageId,
        digest(message.text),
        JSON.stringify(message),
        message.receivedAt
      );
  }

  async recordOutbound(draft: OutboundDraft): Promise<void> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO delivery_jobs (
          job_id, session_key, status, attempt_count, payload_json, last_error, created_at, updated_at
        ) VALUES (?, ?, 'pending', 0, ?, NULL, ?, ?)`
      )
      .run(draft.draftId, draft.sessionKey, JSON.stringify(draft), draft.createdAt, draft.createdAt);
  }

  async hasInbound(messageId: string): Promise<boolean> {
    const row = this.db.prepare(`SELECT 1 FROM message_ledger WHERE message_id = ? AND direction = 'inbound'`).get(messageId);
    return row !== undefined && row !== null;
  }

  async listRecentConversation(sessionKey: string, limit: number): Promise<ConversationEntry[]> {
    const rows = this.db
      .prepare(
        `SELECT direction, text, created_at AS createdAt
         FROM (
           SELECT direction,
                  json_extract(payload_json, '$.text') AS text,
                  created_at
           FROM message_ledger
           WHERE session_key = ?

           UNION ALL

           SELECT 'outbound' AS direction,
                  json_extract(payload_json, '$.text') AS text,
                  created_at
           FROM delivery_jobs
           WHERE session_key = ?
         )
         WHERE text IS NOT NULL AND text != ''
         ORDER BY createdAt DESC
         LIMIT ?`
      )
      .all(sessionKey, sessionKey, limit) as Array<ConversationEntry>;

    return rows.reverse();
  }
}
