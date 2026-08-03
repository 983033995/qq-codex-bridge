import { randomUUID } from "node:crypto";
import type { AppConfig } from "../../../apps/bridge-daemon/src/config.js";
import type { MediaArtifact } from "../../domain/src/message.js";
import type { SqliteDatabase } from "./sqlite.js";

const ADMIN_CONFIG_DRAFT_KEY = "admin.configDraft";

export type RuntimeEventLevel = "info" | "warn" | "error";

export type RuntimeEventInput = {
  level: RuntimeEventLevel;
  source: string;
  message: string;
  details?: unknown;
  createdAt?: string;
};

export type RuntimeEventRow = {
  eventId: string;
  level: RuntimeEventLevel;
  source: string;
  message: string;
  details: unknown;
  createdAt: string;
};

export type AdminSessionRow = {
  sessionKey: string;
  accountKey: string;
  peerKey: string;
  chatType: string;
  peerId: string;
  codexThreadRef: string | null;
  conversationProvider: string | null;
  status: string;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastError: string | null;
};

export type AdminMessageRow = {
  id: string;
  sessionKey: string;
  direction: string;
  status: string | null;
  text: string | null;
  mediaArtifacts: MediaArtifact[];
  mediaReferences: string[];
  payload: unknown;
  lastError: string | null;
  createdAt: string;
};

export type AdminDeliveryErrorRow = {
  jobId: string;
  sessionKey: string;
  status: string;
  lastError: string;
  updatedAt: string;
};

export class AdminRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async saveConfigDraft(value: unknown): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      )
      .run(ADMIN_CONFIG_DRAFT_KEY, JSON.stringify(value), new Date().toISOString());
  }

  async getConfigDraft(): Promise<unknown | null> {
    const row = this.db
      .prepare(`SELECT value_json AS valueJson FROM app_settings WHERE key = ?`)
      .get(ADMIN_CONFIG_DRAFT_KEY) as { valueJson?: string } | undefined;
    return row?.valueJson ? safeJsonParse(row.valueJson) : null;
  }

  async recordEvent(input: RuntimeEventInput): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO runtime_events (event_id, level, source, message, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        input.level,
        input.source,
        input.message,
        input.details === undefined ? null : JSON.stringify(input.details),
        input.createdAt ?? new Date().toISOString()
      );
  }

  async listRuntimeEvents(limit = 100): Promise<RuntimeEventRow[]> {
    const rows = this.db
      .prepare(
        `SELECT event_id AS eventId,
                level,
                source,
                message,
                details_json AS detailsJson,
                created_at AS createdAt
         FROM runtime_events
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(clampLimit(limit)) as Array<RuntimeEventRow & { detailsJson: string | null }>;

    return rows.map(({ detailsJson, ...row }) => ({
      ...row,
      details: detailsJson ? safeJsonParse(detailsJson) : null
    }));
  }

  async listSessions(limit = 100): Promise<AdminSessionRow[]> {
    return this.db
      .prepare(
        `SELECT session_key AS sessionKey,
                account_key AS accountKey,
                peer_key AS peerKey,
                chat_type AS chatType,
                peer_id AS peerId,
                codex_thread_ref AS codexThreadRef,
                conversation_provider AS conversationProvider,
                status,
                last_inbound_at AS lastInboundAt,
                last_outbound_at AS lastOutboundAt,
                last_error AS lastError
         FROM bridge_sessions
         ORDER BY COALESCE(last_inbound_at, last_outbound_at, '') DESC
         LIMIT ?`
      )
      .all(clampLimit(limit)) as AdminSessionRow[];
  }

  async listMessages(options: { sessionKey?: string; limit?: number } = {}): Promise<AdminMessageRow[]> {
    const limit = clampLimit(options.limit ?? 100);
    const rows = options.sessionKey
      ? this.db
          .prepare(
            `SELECT id, sessionKey, direction, status, text, payloadJson, lastError, createdAt
             FROM (
               SELECT message_id AS id,
                      session_key AS sessionKey,
                      direction,
                      NULL AS status,
                      json_extract(payload_json, '$.text') AS text,
                      payload_json AS payloadJson,
                      NULL AS lastError,
                      created_at AS createdAt
               FROM message_ledger
               WHERE session_key = ?

               UNION ALL

               SELECT job_id AS id,
                      session_key AS sessionKey,
                      'outbound' AS direction,
                      status,
                      json_extract(payload_json, '$.text') AS text,
                      payload_json AS payloadJson,
                      last_error AS lastError,
                      created_at AS createdAt
               FROM delivery_jobs
               WHERE session_key = ?
             )
             ORDER BY createdAt DESC
             LIMIT ?`
          )
          .all(options.sessionKey, options.sessionKey, limit)
      : this.db
          .prepare(
            `SELECT id, sessionKey, direction, status, text, payloadJson, lastError, createdAt
             FROM (
               SELECT message_id AS id,
                      session_key AS sessionKey,
                      direction,
                      NULL AS status,
                      json_extract(payload_json, '$.text') AS text,
                      payload_json AS payloadJson,
                      NULL AS lastError,
                      created_at AS createdAt
               FROM message_ledger

               UNION ALL

               SELECT job_id AS id,
                      session_key AS sessionKey,
                      'outbound' AS direction,
                      status,
                      json_extract(payload_json, '$.text') AS text,
                      payload_json AS payloadJson,
                      last_error AS lastError,
                      created_at AS createdAt
               FROM delivery_jobs
             )
             ORDER BY createdAt DESC
             LIMIT ?`
          )
          .all(limit);

    return (
      rows as Array<
        Omit<AdminMessageRow, "payload" | "mediaArtifacts" | "mediaReferences"> & {
          payloadJson: string;
        }
      >
    ).map(({ payloadJson, text, ...row }) => {
        const payload = safeJsonParse(payloadJson);
        return {
          ...row,
          text,
          mediaArtifacts: extractMediaArtifacts(payload),
          mediaReferences: extractMediaReferences(text),
          payload
        };
      });
  }

  async listDeliveryErrors(limit = 50): Promise<AdminDeliveryErrorRow[]> {
    return this.db
      .prepare(
        `SELECT job_id AS jobId,
                session_key AS sessionKey,
                status,
                last_error AS lastError,
                updated_at AS updatedAt
         FROM delivery_jobs
         WHERE last_error IS NOT NULL AND last_error != ''
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(clampLimit(limit)) as AdminDeliveryErrorRow[];
  }

  async hasKnownMediaPath(targetPath: string): Promise<boolean> {
    if (!targetPath) {
      return false;
    }

    const rows = this.db
      .prepare(
        `SELECT payload_json AS payloadJson
         FROM message_ledger
         WHERE payload_json LIKE ?

         UNION ALL

         SELECT payload_json AS payloadJson
         FROM delivery_jobs
         WHERE payload_json LIKE ?
         LIMIT 100`
      )
      .all(`%${targetPath}%`, `%${targetPath}%`) as Array<{ payloadJson: string }>;

    return rows.some((row) => {
      const payload = safeJsonParse(row.payloadJson);
      return extractMediaArtifacts(payload).some(
        (artifact) => artifact.localPath === targetPath || artifact.sourceUrl === targetPath
      ) || extractMediaReferences(extractPayloadText(payload)).includes(targetPath);
    });
  }

  async getStats(): Promise<{
    sessionCount: number;
    inboundCount: number;
    outboundCount: number;
    pendingDeliveryCount: number;
    errorEventCount: number;
  }> {
    return {
      sessionCount: count(this.db, "bridge_sessions"),
      inboundCount: countWhere(this.db, "message_ledger", "direction = 'inbound'"),
      outboundCount: count(this.db, "delivery_jobs"),
      pendingDeliveryCount: countWhere(this.db, "delivery_jobs", "status = 'pending'"),
      errorEventCount: countWhere(this.db, "runtime_events", "level = 'error'")
    };
  }
}

export function redactConfig(config: AppConfig): unknown {
  return redactSecrets(config);
}

function count(db: SqliteDatabase, tableName: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count?: number };
  return Number(row.count ?? 0);
}

function countWhere(db: SqliteDatabase, tableName: string, whereClause: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE ${whereClause}`).get() as {
    count?: number;
  };
  return Number(row.count ?? 0);
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function extractMediaArtifacts(payload: unknown): MediaArtifact[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const mediaArtifacts = (payload as { mediaArtifacts?: unknown }).mediaArtifacts;
  if (!Array.isArray(mediaArtifacts)) {
    return [];
  }

  return mediaArtifacts.filter((item): item is MediaArtifact => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const record = item as Record<string, unknown>;
    return typeof record.kind === "string"
      && typeof record.mimeType === "string"
      && typeof record.fileSize === "number";
  });
}

function extractMediaReferences(text: string | null): string[] {
  if (!text) {
    return [];
  }

  return Array.from(text.matchAll(/<qqmedia>(.*?)<\/qqmedia>/g))
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

function extractPayloadText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const text = (payload as { text?: unknown }).text;
  return typeof text === "string" ? text : null;
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return 100;
  }
  return Math.max(1, Math.min(500, Math.trunc(value)));
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      isSecretKey(key) && typeof nested === "string" ? redactString(nested) : redactSecrets(nested)
    ])
  );
}

function isSecretKey(key: string): boolean {
  return /secret|token|apiKey|accessKey|clientSecret/i.test(key);
}

function redactString(value: string): string {
  if (!value) {
    return "";
  }
  if (value.length <= 8) {
    return "********";
  }
  return `${value.slice(0, 3)}***${value.slice(-4)}`;
}
