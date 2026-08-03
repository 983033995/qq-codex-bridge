import type {
  PublicPushTarget,
  PushFailureCode,
  PushJob,
  PushPayload,
  PushRepositoryPort,
  PushTarget,
  PushTargetRegistryPort
} from "../../ports/src/push.js";
import type { SqliteDatabase } from "./sqlite.js";

type PushJobRow = {
  push_id: string;
  idempotency_key: string;
  target_alias: string;
  status: PushJob["status"];
  payload_json: string;
  attempt_count: number;
  next_attempt_at: string | null;
  provider_message_id: string | null;
  last_error: string | null;
  failure_code: PushFailureCode | null;
  claimed_by: string | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
};

type PushTargetRow = {
  alias: string;
  channel: PushTarget["channel"];
  account_key: string;
  target_type: PushTarget["targetType"];
  provider_target_id: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

export class SqlitePushRepository implements PushRepositoryPort, PushTargetRegistryPort {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async enqueue(input: {
    pushId: string;
    idempotencyKey: string;
    targetAlias: string;
    payload: PushPayload;
    now: string;
  }): Promise<{ job: PushJob; duplicate: boolean }> {
    return this.db.transaction(() => {
      const existing = this.findByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        return { job: mapJob(existing), duplicate: true };
      }
      this.db.prepare(
        `INSERT INTO push_jobs (
          push_id, idempotency_key, target_alias, status, payload_json, attempt_count,
          next_attempt_at, provider_message_id, last_error, failure_code, claimed_by,
          claimed_at, created_at, updated_at, delivered_at
        ) VALUES (?, ?, ?, 'queued', ?, 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)`
      ).run(
        input.pushId,
        input.idempotencyKey,
        input.targetAlias,
        JSON.stringify(input.payload),
        input.now,
        input.now
      );
      return { job: mapJob(this.findByPushId(input.pushId)!), duplicate: false };
    }).immediate();
  }

  async get(pushId: string): Promise<PushJob | null> {
    const row = this.findByPushId(pushId);
    return row ? mapJob(row) : null;
  }

  async claimNext(workerId: string, now: string): Promise<PushJob | null> {
    return this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT * FROM push_jobs
         WHERE status IN ('queued', 'retry_wait')
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at ASC
         LIMIT 1`
      ).get(now) as PushJobRow | undefined;
      if (!row) {
        return null;
      }
      const result = this.db.prepare(
        `UPDATE push_jobs
         SET status = 'sending', attempt_count = attempt_count + 1,
             next_attempt_at = NULL, claimed_by = ?, claimed_at = ?, updated_at = ?
         WHERE push_id = ? AND status IN ('queued', 'retry_wait')`
      ).run(workerId, now, now, row.push_id);
      return result.changes === 1 ? mapJob(this.findByPushId(row.push_id)!) : null;
    }).immediate();
  }

  async markDelivered(input: {
    pushId: string;
    workerId: string;
    providerMessageId: string | null;
    now: string;
  }): Promise<boolean> {
    return this.db.prepare(
      `UPDATE push_jobs
       SET status = 'delivered', provider_message_id = ?, delivered_at = ?, updated_at = ?,
           claimed_by = NULL, claimed_at = NULL, last_error = NULL, failure_code = NULL
       WHERE push_id = ? AND status = 'sending' AND claimed_by = ?`
    ).run(input.providerMessageId, input.now, input.now, input.pushId, input.workerId).changes === 1;
  }

  async markFailedAttempt(input: {
    pushId: string;
    workerId: string;
    code: PushFailureCode;
    error: string;
    nextAttemptAt: string | null;
    now: string;
  }): Promise<boolean> {
    const status = input.nextAttemptAt ? "retry_wait" : "failed";
    return this.db.prepare(
      `UPDATE push_jobs
       SET status = ?, next_attempt_at = ?, last_error = ?, failure_code = ?, updated_at = ?,
           claimed_by = NULL, claimed_at = NULL
       WHERE push_id = ? AND status = 'sending' AND claimed_by = ?`
    ).run(
      status,
      input.nextAttemptAt,
      input.error,
      input.code,
      input.now,
      input.pushId,
      input.workerId
    ).changes === 1;
  }

  async recoverStaleSending(staleBefore: string, now: string): Promise<number> {
    return this.db.prepare(
      `UPDATE push_jobs
       SET status = CASE WHEN attempt_count > 3 THEN 'failed' ELSE 'retry_wait' END,
           next_attempt_at = CASE WHEN attempt_count > 3 THEN NULL ELSE ? END,
           last_error = COALESCE(last_error, 'sending lease expired'),
           failure_code = COALESCE(failure_code, 'temporary_failure'),
           claimed_by = NULL, claimed_at = NULL, updated_at = ?
       WHERE status = 'sending' AND claimed_at < ?`
    ).run(now, now, staleBefore).changes;
  }

  async getTarget(alias: string): Promise<PushTarget | null> {
    const row = this.db.prepare(`SELECT * FROM push_targets WHERE alias = ?`).get(alias) as PushTargetRow | undefined;
    return row ? mapTarget(row) : null;
  }

  async listTargets(): Promise<PublicPushTarget[]> {
    const rows = this.db.prepare(
      `SELECT * FROM push_targets WHERE enabled = 1 ORDER BY alias ASC`
    ).all() as PushTargetRow[];
    return rows.map((row) => {
      const target = mapTarget(row);
      const { providerTargetId: _hidden, ...publicTarget } = target;
      return publicTarget;
    });
  }

  async listAllTargets(): Promise<PublicPushTarget[]> {
    const rows = this.db.prepare(
      `SELECT * FROM push_targets ORDER BY alias ASC`
    ).all() as PushTargetRow[];
    return rows.map(toPublicTarget);
  }

  async saveTarget(target: Omit<PushTarget, "createdAt" | "updatedAt">): Promise<PushTarget> {
    const now = this.now();
    this.db.prepare(
      `INSERT INTO push_targets (
        alias, channel, account_key, target_type, provider_target_id, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(alias) DO UPDATE SET
        channel = excluded.channel, account_key = excluded.account_key,
        target_type = excluded.target_type, provider_target_id = excluded.provider_target_id,
        enabled = excluded.enabled, updated_at = excluded.updated_at`
    ).run(
      target.alias,
      target.channel,
      target.accountKey,
      target.targetType,
      target.providerTargetId,
      target.enabled ? 1 : 0,
      now,
      now
    );
    return (await this.getTarget(target.alias))!;
  }

  async disableTarget(alias: string, now = this.now()): Promise<boolean> {
    return this.db.prepare(
      `UPDATE push_targets SET enabled = 0, updated_at = ? WHERE alias = ?`
    ).run(now, alias).changes === 1;
  }

  private findByPushId(pushId: string): PushJobRow | undefined {
    return this.db.prepare(`SELECT * FROM push_jobs WHERE push_id = ?`).get(pushId) as PushJobRow | undefined;
  }

  private findByIdempotencyKey(key: string): PushJobRow | undefined {
    return this.db.prepare(`SELECT * FROM push_jobs WHERE idempotency_key = ?`).get(key) as PushJobRow | undefined;
  }
}

function mapJob(row: PushJobRow): PushJob {
  return {
    pushId: row.push_id,
    idempotencyKey: row.idempotency_key,
    targetAlias: row.target_alias,
    status: row.status,
    payload: JSON.parse(row.payload_json) as PushPayload,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    providerMessageId: row.provider_message_id,
    lastError: row.last_error,
    failureCode: row.failure_code,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at
  };
}

function mapTarget(row: PushTargetRow): PushTarget {
  return {
    alias: row.alias,
    channel: row.channel,
    accountKey: row.account_key,
    targetType: row.target_type,
    providerTargetId: row.provider_target_id,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toPublicTarget(row: PushTargetRow): PublicPushTarget {
  const { providerTargetId: _hidden, ...publicTarget } = mapTarget(row);
  return publicTarget;
}
