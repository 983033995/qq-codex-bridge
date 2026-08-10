import type {
  ConversationSpace,
  ConversationSpaceId,
  Delivery,
  InboundEnvelope,
  ThreadBinding,
  Turn
} from "../../domain/src/vnext/index.js";
import { VNextDomainError } from "../../domain/src/vnext/index.js";
import type {
  ConversationSpaceRepository,
  CursorPage,
  DeliveryRepository,
  MessageLedger,
  PushJobRecord,
  PushRepository,
  PushTargetRecord,
  RoutingDecisionRecord,
  RoutingDecisionRepository,
  RuntimeEventRecord,
  RuntimeEventRepository,
  ThreadBindingRepository,
  TurnRepository
} from "../../ports/src/vnext/index.js";
import type { SqliteDatabase } from "./database.js";

export class SqliteConversationSpaceRepository implements ConversationSpaceRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async get(spaceId: ConversationSpaceId): Promise<ConversationSpace | null> {
    const row = this.db.prepare("SELECT * FROM conversation_spaces WHERE space_id = ?")
      .get(spaceId) as ConversationSpaceRow | undefined;
    return row ? mapConversationSpace(row) : null;
  }

  async save(space: ConversationSpace): Promise<void> {
    this.db.prepare(`
      INSERT INTO conversation_spaces (
        space_id, channel, account_id, provider_conversation_id, scope,
        display_name, status, last_inbound_at, last_outbound_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(space_id) DO UPDATE SET
        channel = excluded.channel,
        account_id = excluded.account_id,
        provider_conversation_id = excluded.provider_conversation_id,
        scope = excluded.scope,
        display_name = excluded.display_name,
        status = excluded.status,
        last_inbound_at = excluded.last_inbound_at,
        last_outbound_at = excluded.last_outbound_at
    `).run(
      space.spaceId,
      space.channel,
      space.accountId,
      space.providerConversationId,
      space.scope,
      space.displayName,
      space.status,
      space.lastInboundAt,
      space.lastOutboundAt
    );
  }

  async list(input: { limit: number; cursor?: string }): Promise<CursorPage<ConversationSpace>> {
    const limit = clampLimit(input.limit);
    const rows = this.db.prepare(`
      SELECT * FROM conversation_spaces
      WHERE (? IS NULL OR space_id > ?)
      ORDER BY space_id ASC
      LIMIT ?
    `).all(input.cursor ?? null, input.cursor ?? null, limit + 1) as ConversationSpaceRow[];
    return simplePage(rows, limit, mapConversationSpace, (row) => row.space_id);
  }
}

export class SqliteThreadBindingRepository implements ThreadBindingRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async getActiveBySpace(spaceId: ConversationSpaceId): Promise<ThreadBinding | null> {
    const row = this.db.prepare(
      "SELECT * FROM thread_bindings WHERE space_id = ? AND status = 'active'"
    ).get(spaceId) as ThreadBindingRow | undefined;
    return row ? mapThreadBinding(row) : null;
  }

  async listActiveByThread(threadId: string): Promise<ThreadBinding[]> {
    return (this.db.prepare(
      "SELECT * FROM thread_bindings WHERE thread_id = ? AND status = 'active' ORDER BY binding_id"
    ).all(threadId) as ThreadBindingRow[]).map(mapThreadBinding);
  }

  async save(binding: ThreadBinding): Promise<void> {
    try {
      this.db.prepare(`
        INSERT INTO thread_bindings (
          binding_id, space_id, thread_id, thread_title, mode, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(binding_id) DO UPDATE SET
          space_id = excluded.space_id,
          thread_id = excluded.thread_id,
          thread_title = excluded.thread_title,
          mode = excluded.mode,
          status = excluded.status,
          updated_at = excluded.updated_at
      `).run(
        binding.bindingId,
        binding.spaceId,
        binding.threadId,
        binding.threadTitle,
        binding.mode,
        binding.status,
        binding.createdAt,
        binding.updatedAt
      );
    } catch (error) {
      if (isBindingConflictError(error)) {
        throw new VNextDomainError("BINDING_CONFLICT", "Thread binding violates an active binding constraint");
      }
      throw error;
    }
  }

  async detach(bindingId: string, updatedAt: string): Promise<boolean> {
    return this.db.prepare(
      "UPDATE thread_bindings SET status = 'detached', updated_at = ? WHERE binding_id = ? AND status = 'active'"
    ).run(updatedAt, bindingId).changes === 1;
  }
}

export class SqliteMessageLedger implements MessageLedger {
  constructor(private readonly db: SqliteDatabase) {}

  async findByDedupeKey(dedupeKey: string): Promise<InboundEnvelope | null> {
    const row = this.db.prepare("SELECT * FROM messages WHERE dedupe_key = ?")
      .get(dedupeKey) as MessageRow | undefined;
    return row ? mapInboundMessage(row) : null;
  }

  async appendInbound(message: InboundEnvelope, dedupeKey: string): Promise<boolean> {
    try {
      return this.db.prepare(`
        INSERT INTO messages (
          message_id, provider_message_id, space_id, sender_id, received_sequence,
          direction, content_json, dedupe_key, status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'inbound', ?, ?, 'received', ?)
      `).run(
        message.messageId,
        message.providerMessageId,
        message.spaceId,
        message.senderId,
        message.receivedSequence,
        JSON.stringify(message.content),
        dedupeKey,
        message.receivedAt
      ).changes === 1;
    } catch (error) {
      if (isUniqueError(error) && this.db.prepare(
        "SELECT 1 FROM messages WHERE dedupe_key = ?"
      ).get(dedupeKey)) {
        return false;
      }
      throw error;
    }
  }

  async listBySpace(input: {
    spaceId: ConversationSpaceId;
    limit: number;
    cursor?: string;
  }): Promise<CursorPage<InboundEnvelope>> {
    const limit = clampLimit(input.limit);
    const cursor = decodeCursor(input.cursor);
    const rows = this.db.prepare(`
      SELECT * FROM messages
      WHERE space_id = ?
        AND direction = 'inbound'
        AND (? IS NULL OR created_at > ? OR (created_at = ? AND message_id > ?))
      ORDER BY created_at ASC, message_id ASC
      LIMIT ?
    `).all(
      input.spaceId,
      cursor?.at ?? null,
      cursor?.at ?? null,
      cursor?.at ?? null,
      cursor?.id ?? null,
      limit + 1
    ) as MessageRow[];
    return cursorPage(rows, limit, mapInboundMessage, (row) => ({ at: row.created_at, id: row.message_id }));
  }
}

export class SqliteTurnRepository implements TurnRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async get(turnId: string): Promise<Turn | null> {
    const row = this.db.prepare("SELECT * FROM turns WHERE turn_id = ?").get(turnId) as TurnRow | undefined;
    return row ? mapTurn(row) : null;
  }

  async save(turn: Turn): Promise<void> {
    this.db.prepare(`
      INSERT INTO turns (
        turn_id, thread_id, space_id, inbound_message_id, status, transport,
        error_code, queued_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(turn_id) DO UPDATE SET
        status = excluded.status,
        transport = excluded.transport,
        error_code = excluded.error_code,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at
    `).run(
      turn.turnId,
      turn.threadId,
      turn.spaceId,
      turn.inboundMessageId,
      turn.status,
      turn.transport,
      turn.errorCode,
      turn.queuedAt,
      turn.startedAt,
      turn.completedAt
    );
  }

  async listActiveByThread(threadId: string): Promise<Turn[]> {
    return (this.db.prepare(`
      SELECT * FROM turns WHERE thread_id = ? AND status IN ('queued', 'starting', 'running')
      ORDER BY queued_at, turn_id
    `).all(threadId) as TurnRow[]).map(mapTurn);
  }

  async listRecoverable(): Promise<Turn[]> {
    return (this.db.prepare(
      "SELECT * FROM turns WHERE status IN ('starting', 'running') ORDER BY queued_at, turn_id"
    ).all() as TurnRow[]).map(mapTurn);
  }
}

export class SqliteRoutingDecisionRepository implements RoutingDecisionRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async save(record: RoutingDecisionRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO router_decisions (
        decision_id, space_id, message_id, kind, action_json, confidence, clarification,
        provider_request_id, confirmation_status, latency_ms, result, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.decisionId,
      record.spaceId,
      record.messageId,
      record.decision.kind,
      record.decision.action ? JSON.stringify(record.decision.action) : null,
      record.decision.confidence,
      record.decision.clarification ?? null,
      record.decision.providerRequestId ?? null,
      record.confirmationStatus,
      record.latencyMs,
      record.result,
      record.createdAt
    );
  }

  async list(input: { limit: number; cursor?: string }): Promise<CursorPage<RoutingDecisionRecord>> {
    const limit = clampLimit(input.limit);
    const cursor = decodeCursor(input.cursor);
    const rows = this.db.prepare(`
      SELECT * FROM router_decisions
      WHERE (? IS NULL OR created_at > ? OR (created_at = ? AND decision_id > ?))
      ORDER BY created_at, decision_id
      LIMIT ?
    `).all(
      cursor?.at ?? null,
      cursor?.at ?? null,
      cursor?.at ?? null,
      cursor?.id ?? null,
      limit + 1
    ) as RoutingDecisionRow[];
    return cursorPage(rows, limit, mapRoutingDecision, (row) => ({ at: row.created_at, id: row.decision_id }));
  }
}

export class SqliteDeliveryRepository implements DeliveryRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async get(deliveryId: string): Promise<Delivery | null> {
    return this.getBy("delivery_id", deliveryId);
  }

  async findByKey(deliveryKey: string): Promise<Delivery | null> {
    return this.getBy("delivery_key", deliveryKey);
  }

  async save(delivery: Delivery): Promise<void> {
    this.db.prepare(`
      INSERT INTO deliveries (
        delivery_id, delivery_key, space_id, status, provider_message_id,
        attempts, error_code, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(delivery_id) DO UPDATE SET
        status = excluded.status,
        provider_message_id = excluded.provider_message_id,
        attempts = excluded.attempts,
        error_code = excluded.error_code,
        updated_at = excluded.updated_at
    `).run(
      delivery.deliveryId,
      delivery.deliveryKey,
      delivery.spaceId,
      delivery.status,
      delivery.providerMessageId,
      delivery.attempts,
      delivery.errorCode,
      delivery.createdAt,
      delivery.updatedAt
    );
  }

  private async getBy(column: "delivery_id" | "delivery_key", value: string): Promise<Delivery | null> {
    const row = this.db.prepare(`SELECT * FROM deliveries WHERE ${column} = ?`)
      .get(value) as DeliveryRow | undefined;
    return row ? mapDelivery(row) : null;
  }
}

export class SqlitePushRepository implements PushRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async getTarget(alias: string): Promise<PushTargetRecord | null> {
    const row = this.db.prepare("SELECT * FROM push_targets WHERE alias = ?")
      .get(alias) as PushTargetRow | undefined;
    return row ? mapPushTarget(row) : null;
  }

  async listTargets(): Promise<PushTargetRecord[]> {
    return (this.db.prepare(
      "SELECT * FROM push_targets WHERE enabled = 1 ORDER BY alias"
    ).all() as PushTargetRow[]).map(mapPushTarget);
  }

  async saveTarget(target: PushTargetRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO push_targets (alias, space_id, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(alias) DO UPDATE SET
        space_id = excluded.space_id,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(target.alias, target.spaceId, target.enabled ? 1 : 0, target.createdAt, target.updatedAt);
  }

  async enqueue(job: PushJobRecord): Promise<{ job: PushJobRecord; duplicate: boolean }> {
    const existing = this.db.prepare("SELECT * FROM push_jobs WHERE idempotency_key = ?")
      .get(job.idempotencyKey) as PushJobRow | undefined;
    if (existing) {
      return { job: mapPushJob(existing), duplicate: true };
    }
    this.db.prepare(`
      INSERT INTO push_jobs (
        push_id, idempotency_key, target_alias, status, content_json,
        attempt_count, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.pushId,
      job.idempotencyKey,
      job.targetAlias,
      job.status,
      job.contentJson,
      job.attemptCount,
      job.nextAttemptAt,
      job.createdAt,
      job.updatedAt
    );
    return { job, duplicate: false };
  }

  async getJob(pushId: string): Promise<PushJobRecord | null> {
    const row = this.db.prepare("SELECT * FROM push_jobs WHERE push_id = ?")
      .get(pushId) as PushJobRow | undefined;
    return row ? mapPushJob(row) : null;
  }
}

export class SqliteRuntimeEventRepository implements RuntimeEventRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async append(event: RuntimeEventRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO runtime_events (event_id, component, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(event.eventId, event.component, event.type, event.payloadJson, event.createdAt);
  }

  async list(input: { limit: number; cursor?: string }): Promise<CursorPage<RuntimeEventRecord>> {
    const limit = clampLimit(input.limit);
    const cursor = decodeCursor(input.cursor);
    const rows = this.db.prepare(`
      SELECT * FROM runtime_events
      WHERE (? IS NULL OR created_at > ? OR (created_at = ? AND event_id > ?))
      ORDER BY created_at, event_id
      LIMIT ?
    `).all(
      cursor?.at ?? null,
      cursor?.at ?? null,
      cursor?.at ?? null,
      cursor?.id ?? null,
      limit + 1
    ) as RuntimeEventRow[];
    return cursorPage(rows, limit, mapRuntimeEvent, (row) => ({ at: row.created_at, id: row.event_id }));
  }
}

type ConversationSpaceRow = {
  space_id: string; channel: ConversationSpace["channel"]; account_id: string;
  provider_conversation_id: string; scope: ConversationSpace["scope"];
  display_name: string; status: ConversationSpace["status"];
  last_inbound_at: string | null; last_outbound_at: string | null;
};
type ThreadBindingRow = {
  binding_id: string; space_id: string; thread_id: string; thread_title: string;
  mode: ThreadBinding["mode"]; status: ThreadBinding["status"];
  created_at: string; updated_at: string;
};
type MessageRow = {
  message_id: string; provider_message_id: string; space_id: string; sender_id: string;
  received_sequence: number; content_json: string; dedupe_key: string; created_at: string;
};
type TurnRow = {
  turn_id: string; thread_id: string; space_id: string; inbound_message_id: string;
  status: Turn["status"]; transport: Turn["transport"]; error_code: Turn["errorCode"];
  queued_at: string; started_at: string | null; completed_at: string | null;
};
type RoutingDecisionRow = {
  decision_id: string; space_id: string; message_id: string;
  kind: RoutingDecisionRecord["decision"]["kind"]; action_json: string | null;
  confidence: number; clarification: string | null; provider_request_id: string | null;
  confirmation_status: RoutingDecisionRecord["confirmationStatus"]; latency_ms: number;
  result: string | null; created_at: string;
};
type DeliveryRow = {
  delivery_id: string; delivery_key: string; space_id: string; status: Delivery["status"];
  provider_message_id: string | null; attempts: number; error_code: Delivery["errorCode"];
  created_at: string; updated_at: string;
};
type PushTargetRow = { alias: string; space_id: string; enabled: number; created_at: string; updated_at: string };
type PushJobRow = {
  push_id: string; idempotency_key: string; target_alias: string; status: PushJobRecord["status"];
  content_json: string; attempt_count: number; next_attempt_at: string | null;
  created_at: string; updated_at: string;
};
type RuntimeEventRow = { event_id: string; component: string; type: string; payload_json: string; created_at: string };

function mapConversationSpace(row: ConversationSpaceRow): ConversationSpace {
  return {
    spaceId: row.space_id as ConversationSpaceId,
    channel: row.channel,
    accountId: row.account_id as ConversationSpace["accountId"],
    providerConversationId: row.provider_conversation_id,
    scope: row.scope,
    displayName: row.display_name,
    status: row.status,
    lastInboundAt: row.last_inbound_at,
    lastOutboundAt: row.last_outbound_at
  };
}
function mapThreadBinding(row: ThreadBindingRow): ThreadBinding {
  return {
    bindingId: row.binding_id,
    spaceId: row.space_id as ConversationSpaceId,
    threadId: row.thread_id,
    threadTitle: row.thread_title,
    mode: row.mode,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function mapInboundMessage(row: MessageRow): InboundEnvelope {
  return {
    messageId: row.message_id,
    providerMessageId: row.provider_message_id,
    spaceId: row.space_id as ConversationSpaceId,
    senderId: row.sender_id,
    receivedSequence: row.received_sequence,
    receivedAt: row.created_at,
    content: JSON.parse(row.content_json) as InboundEnvelope["content"]
  };
}
function mapTurn(row: TurnRow): Turn {
  return {
    turnId: row.turn_id,
    threadId: row.thread_id,
    spaceId: row.space_id as ConversationSpaceId,
    inboundMessageId: row.inbound_message_id,
    status: row.status,
    transport: row.transport,
    errorCode: row.error_code,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at
  };
}
function mapRoutingDecision(row: RoutingDecisionRow): RoutingDecisionRecord {
  return {
    decisionId: row.decision_id,
    spaceId: row.space_id as ConversationSpaceId,
    messageId: row.message_id,
    decision: {
      kind: row.kind,
      confidence: row.confidence,
      ...(row.action_json ? { action: JSON.parse(row.action_json) as NonNullable<RoutingDecisionRecord["decision"]["action"]> } : {}),
      ...(row.clarification ? { clarification: row.clarification } : {}),
      ...(row.provider_request_id ? { providerRequestId: row.provider_request_id } : {})
    },
    latencyMs: row.latency_ms,
    confirmationStatus: row.confirmation_status,
    result: row.result,
    createdAt: row.created_at
  };
}
function mapDelivery(row: DeliveryRow): Delivery {
  return {
    deliveryId: row.delivery_id,
    deliveryKey: row.delivery_key,
    spaceId: row.space_id as ConversationSpaceId,
    status: row.status,
    providerMessageId: row.provider_message_id,
    attempts: row.attempts,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function mapPushTarget(row: PushTargetRow): PushTargetRecord {
  return { alias: row.alias, spaceId: row.space_id as ConversationSpaceId, enabled: row.enabled === 1, createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapPushJob(row: PushJobRow): PushJobRecord {
  return {
    pushId: row.push_id,
    idempotencyKey: row.idempotency_key,
    targetAlias: row.target_alias,
    status: row.status,
    contentJson: row.content_json,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function mapRuntimeEvent(row: RuntimeEventRow): RuntimeEventRecord {
  return { eventId: row.event_id, component: row.component, type: row.type, payloadJson: row.payload_json, createdAt: row.created_at };
}

function simplePage<TRow, TItem>(
  rows: TRow[],
  limit: number,
  map: (row: TRow) => TItem,
  cursor: (row: TRow) => string
): CursorPage<TItem> {
  const pageRows = rows.slice(0, limit);
  return {
    items: pageRows.map(map),
    nextCursor: rows.length > limit && pageRows.length ? cursor(pageRows.at(-1)!) : null
  };
}
function cursorPage<TRow, TItem>(
  rows: TRow[],
  limit: number,
  map: (row: TRow) => TItem,
  cursor: (row: TRow) => CursorValue
): CursorPage<TItem> {
  const pageRows = rows.slice(0, limit);
  return {
    items: pageRows.map(map),
    nextCursor: rows.length > limit && pageRows.length ? encodeCursor(cursor(pageRows.at(-1)!)) : null
  };
}
type CursorValue = { at: string; id: string };
function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
function decodeCursor(value?: string): CursorValue | null {
  if (!value) return null;
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CursorValue>;
  if (typeof parsed.at !== "string" || typeof parsed.id !== "string") {
    throw new Error("Invalid cursor");
  }
  return { at: parsed.at, id: parsed.id };
}
function clampLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("Page limit must be an integer between 1 and 200");
  }
  return limit;
}
function isConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && String(error.code).startsWith("SQLITE_CONSTRAINT"));
}
function isUniqueError(error: unknown): boolean {
  return isConstraintError(error) && /UNIQUE|PRIMARY KEY/i.test(error instanceof Error ? error.message : String(error));
}
function isBindingConflictError(error: unknown): boolean {
  if (!isConstraintError(error)) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("active thread binding conflicts with exclusive binding")
    || message.includes("UNIQUE constraint failed: thread_bindings.space_id")
    || message.includes("UNIQUE constraint failed: thread_bindings.thread_id");
}
