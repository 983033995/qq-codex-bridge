import type {
  ActiveConversation,
  ChannelMessageRegistryEntry,
  ConversationAlias,
  ConversationSpace,
  ConversationSpaceId,
  Delivery,
  InboundEnvelope,
  MessageContent,
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
import type {
  ApprovalRepository,
  ApprovalRequest,
  ApprovalStatus,
  AppServerRequestId
} from "../../approval/src/index.js";
import type {
  SetupChannel,
  SetupRepository,
  SetupSession
} from "../../setup/src/index.js";
import type {
  ActiveConversationRepository,
  ChannelMessageRegistryRepository,
  ConversationAliasRepository
} from "../../ports/src/vnext/index.js";

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

export class SqliteConversationAliasRepository implements ConversationAliasRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async get(alias: string): Promise<ConversationAlias | null> {
    const row = this.db.prepare(
      "SELECT * FROM conversation_aliases WHERE alias = ?"
    ).get(alias) as ConversationAliasRow | undefined;
    return row ? mapConversationAlias(row) : null;
  }

  async findBySource(input: {
    provider: string;
    sourceConversationId: string;
  }): Promise<ConversationAlias | null> {
    const row = this.db.prepare(`
      SELECT * FROM conversation_aliases
      WHERE provider = ? AND source_conversation_id = ?
    `).get(input.provider, input.sourceConversationId) as ConversationAliasRow | undefined;
    return row ? mapConversationAlias(row) : null;
  }

  async save(alias: ConversationAlias): Promise<void> {
    this.db.prepare(`
      INSERT INTO conversation_aliases (
        alias, provider, instance_id, source_conversation_id,
        project_id, project_name, task_id, task_title, capability,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(alias) DO UPDATE SET
        provider = excluded.provider,
        instance_id = excluded.instance_id,
        source_conversation_id = excluded.source_conversation_id,
        project_id = excluded.project_id,
        project_name = excluded.project_name,
        task_id = excluded.task_id,
        task_title = excluded.task_title,
        capability = excluded.capability,
        updated_at = excluded.updated_at
    `).run(
      alias.alias,
      alias.provider,
      alias.instanceId,
      alias.sourceConversationId,
      alias.projectId,
      alias.projectName,
      alias.taskId,
      alias.taskTitle,
      alias.capability,
      alias.createdAt,
      alias.updatedAt
    );
  }
}

export class SqliteChannelMessageRegistryRepository implements ChannelMessageRegistryRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async getByChannelMessage(input: {
    channel: ConversationSpace["channel"];
    channelAccountId: ConversationSpace["accountId"];
    peerId: string;
    channelMessageId: string;
  }): Promise<ChannelMessageRegistryEntry | null> {
    const row = this.db.prepare(`
      SELECT * FROM channel_message_registry
      WHERE channel = ? AND channel_account_id = ? AND peer_id = ? AND channel_message_id = ?
    `).get(
      input.channel,
      input.channelAccountId,
      input.peerId,
      input.channelMessageId
    ) as ChannelMessageRegistryRow | undefined;
    return row ? mapChannelMessageRegistryEntry(row) : null;
  }

  async listByScope(input: {
    channel: ConversationSpace["channel"];
    channelAccountId: ConversationSpace["accountId"];
    peerId: string;
    limit: number;
  }): Promise<ChannelMessageRegistryEntry[]> {
    return (this.db.prepare(`
      SELECT * FROM channel_message_registry
      WHERE channel = ? AND channel_account_id = ? AND peer_id = ?
      ORDER BY created_at DESC, registry_id DESC
      LIMIT ?
    `).all(
      input.channel,
      input.channelAccountId,
      input.peerId,
      clampLimit(input.limit)
    ) as ChannelMessageRegistryRow[]).map(mapChannelMessageRegistryEntry);
  }

  async save(entry: ChannelMessageRegistryEntry): Promise<void> {
    this.db.prepare(`
      INSERT INTO channel_message_registry (
        registry_id, channel, channel_account_id, peer_id, channel_message_id,
        gateway_message_id, provider, source_conversation_id, source_alias,
        task_id, capability, direction, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel, channel_account_id, peer_id, channel_message_id) DO UPDATE SET
        gateway_message_id = excluded.gateway_message_id,
        provider = excluded.provider,
        source_conversation_id = excluded.source_conversation_id,
        source_alias = excluded.source_alias,
        task_id = excluded.task_id,
        capability = excluded.capability,
        direction = excluded.direction,
        created_at = excluded.created_at
    `).run(
      entry.registryId,
      entry.channel,
      entry.channelAccountId,
      entry.peerId,
      entry.channelMessageId,
      entry.gatewayMessageId,
      entry.provider,
      entry.sourceConversationId,
      entry.sourceAlias,
      entry.taskId,
      entry.capability,
      entry.direction,
      entry.createdAt
    );
  }
}

export class SqliteActiveConversationRepository implements ActiveConversationRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async get(input: {
    channel: ConversationSpace["channel"];
    channelAccountId: ConversationSpace["accountId"];
    peerId: string;
  }): Promise<ActiveConversation | null> {
    const row = this.db.prepare(`
      SELECT * FROM active_conversations
      WHERE channel = ? AND channel_account_id = ? AND peer_id = ?
    `).get(input.channel, input.channelAccountId, input.peerId) as ActiveConversationRow | undefined;
    return row ? mapActiveConversation(row) : null;
  }

  async save(active: ActiveConversation): Promise<void> {
    this.db.prepare(`
      INSERT INTO active_conversations (
        channel, channel_account_id, peer_id, conversation_alias,
        source_conversation_id, updated_by, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel, channel_account_id, peer_id) DO UPDATE SET
        conversation_alias = excluded.conversation_alias,
        source_conversation_id = excluded.source_conversation_id,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
    `).run(
      active.channel,
      active.channelAccountId,
      active.peerId,
      active.conversationAlias,
      active.sourceConversationId,
      active.updatedBy,
      active.updatedAt
    );
  }
}

export class SqliteMessageLedger implements MessageLedger {
  constructor(private readonly db: SqliteDatabase) {}

  async getById(messageId: string): Promise<InboundEnvelope | null> {
    const row = this.db.prepare("SELECT * FROM messages WHERE message_id = ?")
      .get(messageId) as MessageRow | undefined;
    return row ? mapInboundMessage(row) : null;
  }

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
        error_code, queued_at, started_at, completed_at, result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(turn_id) DO UPDATE SET
        status = excluded.status,
        transport = excluded.transport,
        error_code = excluded.error_code,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        result_json = excluded.result_json
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
      turn.completedAt,
      turn.result ? JSON.stringify(turn.result) : null
    );
  }

  async listActiveByThread(threadId: string): Promise<Turn[]> {
    return (this.db.prepare(`
      SELECT * FROM turns WHERE thread_id = ? AND status IN ('queued', 'starting', 'running', 'unknown')
      ORDER BY queued_at, turn_id
    `).all(threadId) as TurnRow[]).map(mapTurn);
  }

  async listRecoverable(): Promise<Turn[]> {
    return (this.db.prepare(
      "SELECT * FROM turns WHERE status IN ('starting', 'running', 'unknown') ORDER BY queued_at, turn_id"
    ).all() as TurnRow[]).map(mapTurn);
  }

  async listCompleted(): Promise<Turn[]> {
    return (this.db.prepare(
      "SELECT * FROM turns WHERE status = 'completed' ORDER BY completed_at, turn_id"
    ).all() as TurnRow[]).map(mapTurn);
  }

  async list(input: { limit: number; cursor?: string }): Promise<CursorPage<Turn>> {
    const limit = clampLimit(input.limit);
    const cursor = decodeCursor(input.cursor);
    const rows = this.db.prepare(`
      SELECT * FROM turns
      WHERE (? IS NULL OR queued_at < ? OR (queued_at = ? AND turn_id < ?))
      ORDER BY queued_at DESC, turn_id DESC
      LIMIT ?
    `).all(
      cursor?.at ?? null,
      cursor?.at ?? null,
      cursor?.at ?? null,
      cursor?.id ?? null,
      limit + 1
    ) as TurnRow[];
    return cursorPage(rows, limit, mapTurn, (row) => ({ at: row.queued_at, id: row.turn_id }));
  }
}

export class SqliteRoutingDecisionRepository implements RoutingDecisionRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async save(record: RoutingDecisionRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO router_decisions (
        decision_id, space_id, message_id, kind, action_json, confidence, risk, mode,
        clarification, provider_request_id, fallback_reason, confirmation_status,
        latency_ms, result, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.decisionId,
      record.spaceId,
      record.messageId,
      record.decision.kind,
      record.decision.actions
        ? JSON.stringify(record.decision.actions)
        : record.decision.action
          ? JSON.stringify(record.decision.action)
          : null,
      record.decision.confidence,
      record.decision.risk,
      record.decision.mode,
      record.decision.clarification ?? null,
      record.decision.providerRequestId ?? null,
      record.decision.fallbackReason ?? null,
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

  async listRecoverable(input: { limit: number }): Promise<Array<{
    delivery: Delivery;
    content: MessageContent;
  }>> {
    return (this.db.prepare(`
      SELECT * FROM deliveries
      WHERE status IN ('pending', 'sending', 'retry_wait')
      ORDER BY COALESCE(next_attempt_at, updated_at), delivery_id
      LIMIT ?
    `).all(clampLimit(input.limit)) as DeliveryRow[]).map((row) => ({
      delivery: mapDelivery(row),
      content: JSON.parse(row.content_json) as MessageContent
    }));
  }

  async save(delivery: Delivery, content?: MessageContent): Promise<void> {
    this.db.prepare(`
      INSERT INTO deliveries (
        delivery_id, delivery_key, space_id, status, provider_message_id,
        attempts, error_code, content_json, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(delivery_id) DO UPDATE SET
        status = excluded.status,
        provider_message_id = excluded.provider_message_id,
        attempts = excluded.attempts,
        error_code = excluded.error_code,
        content_json = CASE
          WHEN ? = 1 THEN excluded.content_json
          ELSE deliveries.content_json
        END,
        next_attempt_at = excluded.next_attempt_at,
        updated_at = excluded.updated_at
    `).run(
      delivery.deliveryId,
      delivery.deliveryKey,
      delivery.spaceId,
      delivery.status,
      delivery.providerMessageId,
      delivery.attempts,
      delivery.errorCode,
      content ? JSON.stringify(content) : '{"text":"","mentions":[],"attachments":[]}',
      delivery.nextAttemptAt,
      delivery.createdAt,
      delivery.updatedAt,
      content ? 1 : 0
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

export class SqliteSetupRepository implements SetupRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async get(setupId: string): Promise<SetupSession | null> {
    const row = this.db.prepare("SELECT * FROM setup_sessions WHERE setup_id = ?")
      .get(setupId) as SetupSessionRow | undefined;
    return row ? mapSetupSession(row) : null;
  }

  async findActive(channel: SetupChannel, accountId: string): Promise<SetupSession | null> {
    const row = this.db.prepare(`
      SELECT * FROM setup_sessions
      WHERE channel = ? AND account_id = ?
        AND status NOT IN ('connected', 'failed', 'cancelled')
      ORDER BY updated_at DESC, setup_id DESC
      LIMIT 1
    `).get(channel, accountId) as SetupSessionRow | undefined;
    return row ? mapSetupSession(row) : null;
  }

  async save(session: SetupSession): Promise<void> {
    this.db.prepare(`
      INSERT INTO setup_sessions (
        setup_id, channel, account_id, status, message, artifact_json,
        error_code, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(setup_id) DO UPDATE SET
        status = excluded.status,
        message = excluded.message,
        artifact_json = excluded.artifact_json,
        error_code = excluded.error_code,
        updated_at = excluded.updated_at
    `).run(
      session.setupId,
      session.channel,
      session.accountId,
      session.status,
      session.message,
      session.artifact ? JSON.stringify(session.artifact) : null,
      session.errorCode,
      session.createdAt,
      session.updatedAt
    );
  }

  async list(input: { channel?: SetupChannel; accountId?: string } = {}): Promise<SetupSession[]> {
    return (this.db.prepare(`
      SELECT * FROM setup_sessions
      WHERE (? IS NULL OR channel = ?)
        AND (? IS NULL OR account_id = ?)
      ORDER BY updated_at DESC, setup_id DESC
      LIMIT 100
    `).all(
      input.channel ?? null,
      input.channel ?? null,
      input.accountId ?? null,
      input.accountId ?? null
    ) as SetupSessionRow[]).map(mapSetupSession);
  }
}

export class SqliteApprovalRepository implements ApprovalRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async get(approvalId: string): Promise<ApprovalRequest | null> {
    const row = this.db.prepare("SELECT * FROM approval_requests WHERE approval_id = ?")
      .get(approvalId) as ApprovalRequestRow | undefined;
    return row ? mapApprovalRequest(row) : null;
  }

  async findByRequestKey(requestKey: string): Promise<ApprovalRequest | null> {
    const row = this.db.prepare("SELECT * FROM approval_requests WHERE request_key = ?")
      .get(requestKey) as ApprovalRequestRow | undefined;
    return row ? mapApprovalRequest(row) : null;
  }

  async findUnresolvedByServerRequest(
    threadId: string,
    requestId: AppServerRequestId
  ): Promise<ApprovalRequest | null> {
    const row = this.db.prepare(`
      SELECT * FROM approval_requests
      WHERE thread_id = ? AND appserver_request_id_json = ?
        AND status IN ('pending', 'resolving')
      ORDER BY created_at DESC, approval_id DESC
      LIMIT 1
    `).get(threadId, JSON.stringify(requestId)) as ApprovalRequestRow | undefined;
    return row ? mapApprovalRequest(row) : null;
  }

  async list(input: {
    status?: ApprovalStatus;
    threadId?: string;
    limit?: number;
  } = {}): Promise<ApprovalRequest[]> {
    return (this.db.prepare(`
      SELECT * FROM approval_requests
      WHERE (? IS NULL OR status = ?)
        AND (? IS NULL OR thread_id = ?)
      ORDER BY created_at DESC, approval_id DESC
      LIMIT ?
    `).all(
      input.status ?? null,
      input.status ?? null,
      input.threadId ?? null,
      input.threadId ?? null,
      clampLimit(input.limit ?? 100)
    ) as ApprovalRequestRow[]).map(mapApprovalRequest);
  }

  async save(request: ApprovalRequest): Promise<void> {
    this.db.prepare(`
      INSERT INTO approval_requests (
        approval_id, request_key, appserver_request_id_json, kind, method,
        thread_id, turn_id, item_id, reason, command, cwd, grant_root,
        params_json, status, resolution, error, created_at, updated_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(approval_id) DO UPDATE SET
        status = excluded.status,
        resolution = excluded.resolution,
        error = excluded.error,
        updated_at = excluded.updated_at,
        resolved_at = excluded.resolved_at
    `).run(
      request.approvalId,
      request.requestKey,
      JSON.stringify(request.appServerRequestId),
      request.kind,
      request.method,
      request.threadId,
      request.turnId,
      request.itemId,
      request.reason,
      request.command,
      request.cwd,
      request.grantRoot,
      JSON.stringify(request.params),
      request.status,
      request.resolution,
      request.error,
      request.createdAt,
      request.updatedAt,
      request.resolvedAt
    );
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
type ConversationAliasRow = {
  alias: string; provider: string; instance_id: string | null;
  source_conversation_id: string; project_id: string | null; project_name: string | null;
  task_id: string | null; task_title: string | null;
  capability: ConversationAlias["capability"]; created_at: string; updated_at: string;
};
type ChannelMessageRegistryRow = {
  registry_id: string; channel: ConversationSpace["channel"];
  channel_account_id: string; peer_id: string; channel_message_id: string;
  gateway_message_id: string; provider: string; source_conversation_id: string | null;
  source_alias: string | null; task_id: string | null;
  capability: ChannelMessageRegistryEntry["capability"];
  direction: ChannelMessageRegistryEntry["direction"]; created_at: string;
};
type ActiveConversationRow = {
  channel: ConversationSpace["channel"]; channel_account_id: string; peer_id: string;
  conversation_alias: string; source_conversation_id: string;
  updated_by: ActiveConversation["updatedBy"]; updated_at: string;
};
type MessageRow = {
  message_id: string; provider_message_id: string; space_id: string; sender_id: string;
  received_sequence: number; content_json: string; dedupe_key: string; created_at: string;
};
type TurnRow = {
  turn_id: string; thread_id: string; space_id: string; inbound_message_id: string;
  status: Turn["status"]; transport: Turn["transport"]; error_code: Turn["errorCode"];
  queued_at: string; started_at: string | null; completed_at: string | null;
  result_json: string | null;
};
type RoutingDecisionRow = {
  decision_id: string; space_id: string; message_id: string;
  kind: RoutingDecisionRecord["decision"]["kind"]; action_json: string | null;
  confidence: number; clarification: string | null; provider_request_id: string | null;
  risk: RoutingDecisionRecord["decision"]["risk"];
  mode: RoutingDecisionRecord["decision"]["mode"];
  fallback_reason: string | null;
  confirmation_status: RoutingDecisionRecord["confirmationStatus"]; latency_ms: number;
  result: string | null; created_at: string;
};
type DeliveryRow = {
  delivery_id: string; delivery_key: string; space_id: string; status: Delivery["status"];
  provider_message_id: string | null; attempts: number; error_code: Delivery["errorCode"];
  content_json: string; next_attempt_at: string | null;
  created_at: string; updated_at: string;
};
type PushTargetRow = { alias: string; space_id: string; enabled: number; created_at: string; updated_at: string };
type PushJobRow = {
  push_id: string; idempotency_key: string; target_alias: string; status: PushJobRecord["status"];
  content_json: string; attempt_count: number; next_attempt_at: string | null;
  created_at: string; updated_at: string;
};
type RuntimeEventRow = { event_id: string; component: string; type: string; payload_json: string; created_at: string };
type SetupSessionRow = {
  setup_id: string; channel: SetupSession["channel"]; account_id: string;
  status: SetupSession["status"]; message: string; artifact_json: string | null;
  error_code: string | null; created_at: string; updated_at: string;
};
type ApprovalRequestRow = {
  approval_id: string; request_key: string; appserver_request_id_json: string;
  kind: ApprovalRequest["kind"]; method: ApprovalRequest["method"];
  thread_id: string; turn_id: string; item_id: string;
  reason: string | null; command: string | null; cwd: string | null; grant_root: string | null;
  params_json: string; status: ApprovalRequest["status"];
  resolution: ApprovalRequest["resolution"]; error: string | null;
  created_at: string; updated_at: string; resolved_at: string | null;
};

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
function mapConversationAlias(row: ConversationAliasRow): ConversationAlias {
  return {
    alias: row.alias,
    provider: row.provider,
    instanceId: row.instance_id,
    sourceConversationId: row.source_conversation_id,
    projectId: row.project_id,
    projectName: row.project_name,
    taskId: row.task_id,
    taskTitle: row.task_title,
    capability: row.capability,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function mapChannelMessageRegistryEntry(row: ChannelMessageRegistryRow): ChannelMessageRegistryEntry {
  return {
    registryId: row.registry_id,
    channel: row.channel,
    channelAccountId: row.channel_account_id as ConversationSpace["accountId"],
    peerId: row.peer_id,
    channelMessageId: row.channel_message_id,
    gatewayMessageId: row.gateway_message_id,
    provider: row.provider,
    sourceConversationId: row.source_conversation_id,
    sourceAlias: row.source_alias,
    taskId: row.task_id,
    capability: row.capability,
    direction: row.direction,
    createdAt: row.created_at
  };
}
function mapActiveConversation(row: ActiveConversationRow): ActiveConversation {
  return {
    channel: row.channel,
    channelAccountId: row.channel_account_id as ConversationSpace["accountId"],
    peerId: row.peer_id,
    conversationAlias: row.conversation_alias,
    sourceConversationId: row.source_conversation_id,
    updatedBy: row.updated_by,
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
    completedAt: row.completed_at,
    ...(row.result_json ? { result: JSON.parse(row.result_json) as Turn["result"] } : {})
  };
}
function mapRoutingDecision(row: RoutingDecisionRow): RoutingDecisionRecord {
  const storedActions = row.action_json ? JSON.parse(row.action_json) as unknown : null;
  return {
    decisionId: row.decision_id,
    spaceId: row.space_id as ConversationSpaceId,
    messageId: row.message_id,
    decision: {
      kind: row.kind,
      confidence: row.confidence,
      risk: row.risk,
      mode: row.mode,
      ...(Array.isArray(storedActions)
        ? { actions: storedActions as NonNullable<RoutingDecisionRecord["decision"]["actions"]> }
        : storedActions
          ? { action: storedActions as NonNullable<RoutingDecisionRecord["decision"]["action"]> }
          : {}),
      ...(row.clarification ? { clarification: row.clarification } : {}),
      ...(row.provider_request_id ? { providerRequestId: row.provider_request_id } : {}),
      ...(row.fallback_reason ? { fallbackReason: row.fallback_reason } : {})
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
    nextAttemptAt: row.next_attempt_at,
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
function mapSetupSession(row: SetupSessionRow): SetupSession {
  return {
    setupId: row.setup_id,
    channel: row.channel,
    accountId: row.account_id,
    status: row.status,
    message: row.message,
    artifact: row.artifact_json ? JSON.parse(row.artifact_json) as SetupSession["artifact"] : null,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function mapApprovalRequest(row: ApprovalRequestRow): ApprovalRequest {
  return {
    approvalId: row.approval_id,
    requestKey: row.request_key,
    appServerRequestId: JSON.parse(row.appserver_request_id_json) as AppServerRequestId,
    kind: row.kind,
    method: row.method,
    threadId: row.thread_id,
    turnId: row.turn_id,
    itemId: row.item_id,
    reason: row.reason,
    command: row.command,
    cwd: row.cwd,
    grantRoot: row.grant_root,
    params: JSON.parse(row.params_json) as Record<string, unknown>,
    status: row.status,
    resolution: row.resolution,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at
  };
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
