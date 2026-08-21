export type SchemaMigration = {
  version: number;
  name: string;
  sql: string;
};

export const schemaMigrations: readonly SchemaMigration[] = [
  {
    version: 1,
    name: "vnext_core",
    sql: `
      CREATE TABLE conversation_spaces (
        space_id TEXT PRIMARY KEY,
        channel TEXT NOT NULL CHECK (channel IN ('weixin', 'feishu', 'qq')),
        account_id TEXT NOT NULL,
        provider_conversation_id TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('c2c', 'group')),
        display_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'unavailable')),
        last_inbound_at TEXT,
        last_outbound_at TEXT
      ) STRICT;

      CREATE TABLE thread_bindings (
        binding_id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL REFERENCES conversation_spaces(space_id),
        thread_id TEXT NOT NULL,
        thread_title TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('exclusive', 'shared')),
        status TEXT NOT NULL CHECK (status IN ('active', 'detached', 'broken')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX uq_thread_bindings_active_space
        ON thread_bindings(space_id) WHERE status = 'active';
      CREATE UNIQUE INDEX uq_thread_bindings_active_exclusive_thread
        ON thread_bindings(thread_id) WHERE status = 'active' AND mode = 'exclusive';
      CREATE TRIGGER trg_thread_bindings_exclusive_insert
      BEFORE INSERT ON thread_bindings
      WHEN NEW.status = 'active' AND EXISTS (
        SELECT 1 FROM thread_bindings existing
        WHERE existing.thread_id = NEW.thread_id
          AND existing.status = 'active'
          AND (existing.mode = 'exclusive' OR NEW.mode = 'exclusive')
      )
      BEGIN
        SELECT RAISE(ABORT, 'active thread binding conflicts with exclusive binding');
      END;
      CREATE TRIGGER trg_thread_bindings_exclusive_update
      BEFORE UPDATE ON thread_bindings
      WHEN NEW.status = 'active' AND EXISTS (
        SELECT 1 FROM thread_bindings existing
        WHERE existing.thread_id = NEW.thread_id
          AND existing.status = 'active'
          AND existing.binding_id != NEW.binding_id
          AND (existing.mode = 'exclusive' OR NEW.mode = 'exclusive')
      )
      BEGIN
        SELECT RAISE(ABORT, 'active thread binding conflicts with exclusive binding');
      END;

      CREATE TABLE messages (
        message_id TEXT PRIMARY KEY,
        provider_message_id TEXT NOT NULL,
        space_id TEXT NOT NULL REFERENCES conversation_spaces(space_id),
        sender_id TEXT NOT NULL,
        received_sequence INTEGER NOT NULL CHECK (received_sequence >= 0),
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'system')),
        content_json TEXT NOT NULL CHECK (json_valid(content_json)),
        dedupe_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_messages_space_cursor ON messages(space_id, created_at, message_id);

      CREATE TABLE turns (
        turn_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        space_id TEXT NOT NULL REFERENCES conversation_spaces(space_id),
        inbound_message_id TEXT NOT NULL REFERENCES messages(message_id),
        status TEXT NOT NULL CHECK (status IN ('queued', 'starting', 'running', 'completed', 'failed', 'interrupted')),
        transport TEXT NOT NULL CHECK (transport IN ('app-server', 'cdp-recovery')),
        error_code TEXT,
        queued_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      ) STRICT;
      CREATE INDEX idx_turns_thread_status ON turns(thread_id, status);

      CREATE TABLE router_decisions (
        decision_id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL REFERENCES conversation_spaces(space_id),
        message_id TEXT NOT NULL REFERENCES messages(message_id),
        kind TEXT NOT NULL CHECK (kind IN ('chat', 'control', 'clarify')),
        action_json TEXT CHECK (action_json IS NULL OR json_valid(action_json)),
        confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
        clarification TEXT,
        provider_request_id TEXT,
        confirmation_status TEXT NOT NULL,
        latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
        result TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE deliveries (
        delivery_id TEXT PRIMARY KEY,
        delivery_key TEXT NOT NULL UNIQUE,
        space_id TEXT NOT NULL REFERENCES conversation_spaces(space_id),
        status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'retry_wait', 'delivered', 'failed')),
        provider_message_id TEXT,
        attempts INTEGER NOT NULL CHECK (attempts >= 0),
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE push_targets (
        alias TEXT PRIMARY KEY,
        space_id TEXT NOT NULL UNIQUE REFERENCES conversation_spaces(space_id),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE push_jobs (
        push_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        target_alias TEXT NOT NULL REFERENCES push_targets(alias),
        status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'retry_wait', 'delivered', 'failed')),
        content_json TEXT NOT NULL CHECK (json_valid(content_json)),
        attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
        next_attempt_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_push_jobs_claim ON push_jobs(status, next_attempt_at, created_at);

      CREATE TABLE runtime_events (
        event_id TEXT PRIMARY KEY,
        component TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_runtime_events_cursor ON runtime_events(created_at, event_id);

      CREATE TABLE config_revisions (
        revision TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'failed', 'rolled_back')),
        effects_json TEXT NOT NULL CHECK (json_valid(effects_json)),
        created_at TEXT NOT NULL,
        activated_at TEXT,
        error_code TEXT
      ) STRICT;
    `
  },
  {
    version: 2,
    name: "turn_unknown_recovery_status",
    sql: `
      ALTER TABLE turns RENAME TO turns_v1;
      CREATE TABLE turns (
        turn_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        space_id TEXT NOT NULL REFERENCES conversation_spaces(space_id),
        inbound_message_id TEXT NOT NULL REFERENCES messages(message_id),
        status TEXT NOT NULL CHECK (status IN ('queued', 'starting', 'running', 'unknown', 'completed', 'failed', 'interrupted')),
        transport TEXT NOT NULL CHECK (transport IN ('app-server', 'cdp-recovery')),
        error_code TEXT,
        queued_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      ) STRICT;
      INSERT INTO turns (
        turn_id, thread_id, space_id, inbound_message_id, status, transport,
        error_code, queued_at, started_at, completed_at
      )
      SELECT
        turn_id, thread_id, space_id, inbound_message_id, status, transport,
        error_code, queued_at, started_at, completed_at
      FROM turns_v1;
      DROP TABLE turns_v1;
      CREATE INDEX idx_turns_thread_status ON turns(thread_id, status);
    `
  },
  {
    version: 3,
    name: "delivery_retry_recovery",
    sql: `
      ALTER TABLE deliveries ADD COLUMN content_json TEXT NOT NULL
        DEFAULT '{"text":"","mentions":[],"attachments":[]}'
        CHECK (json_valid(content_json));
      ALTER TABLE deliveries ADD COLUMN next_attempt_at TEXT;
      UPDATE deliveries
      SET status = 'failed',
          error_code = COALESCE(error_code, 'CHANNEL_DELIVERY_FAILED')
      WHERE status IN ('pending', 'sending', 'retry_wait');
      CREATE INDEX idx_deliveries_recovery
        ON deliveries(status, next_attempt_at, updated_at, delivery_id);
    `
  },
  {
    version: 4,
    name: "persistent_channel_setup",
    sql: `
      CREATE TABLE setup_sessions (
        setup_id TEXT PRIMARY KEY,
        channel TEXT NOT NULL CHECK (channel IN ('qq', 'weixin', 'feishu')),
        account_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'awaiting_input', 'requesting_qr', 'awaiting_scan', 'awaiting_confirmation',
          'restart_required', 'connected', 'action_required', 'failed', 'cancelled'
        )),
        message TEXT NOT NULL,
        artifact_json TEXT CHECK (artifact_json IS NULL OR json_valid(artifact_json)),
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_setup_sessions_account
        ON setup_sessions(channel, account_id, updated_at DESC, setup_id DESC);
    `
  },
  {
    version: 5,
    name: "v03_inbound_router_decisions",
    sql: `
      ALTER TABLE router_decisions RENAME TO router_decisions_v2;
      CREATE TABLE router_decisions (
        decision_id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL REFERENCES conversation_spaces(space_id),
        message_id TEXT NOT NULL REFERENCES messages(message_id),
        kind TEXT NOT NULL CHECK (kind IN ('conversation', 'control', 'setup', 'approval', 'unknown')),
        action_json TEXT CHECK (action_json IS NULL OR json_valid(action_json)),
        confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
        risk TEXT NOT NULL CHECK (risk IN ('read', 'low', 'medium', 'high')),
        mode TEXT NOT NULL CHECK (mode IN ('off', 'assist', 'auto')),
        clarification TEXT,
        provider_request_id TEXT,
        fallback_reason TEXT,
        confirmation_status TEXT NOT NULL,
        latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
        result TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO router_decisions (
        decision_id, space_id, message_id, kind, action_json, confidence,
        risk, mode, clarification, provider_request_id, fallback_reason,
        confirmation_status, latency_ms, result, created_at
      )
      SELECT
        decision_id, space_id, message_id,
        CASE kind WHEN 'chat' THEN 'conversation' WHEN 'clarify' THEN 'unknown' ELSE kind END,
        action_json, confidence,
        CASE WHEN kind = 'control' THEN 'low' ELSE 'read' END,
        'assist', clarification, provider_request_id, NULL,
        confirmation_status, latency_ms, result, created_at
      FROM router_decisions_v2;
      DROP TABLE router_decisions_v2;
      CREATE INDEX idx_router_decisions_cursor
        ON router_decisions(created_at, decision_id);
    `
  },
  {
    version: 6,
    name: "persistent_appserver_approvals",
    sql: `
      CREATE TABLE approval_requests (
        approval_id TEXT PRIMARY KEY,
        request_key TEXT NOT NULL UNIQUE,
        appserver_request_id_json TEXT NOT NULL CHECK (json_valid(appserver_request_id_json)),
        kind TEXT NOT NULL CHECK (kind IN ('command_execution', 'file_change')),
        method TEXT NOT NULL CHECK (method IN (
          'item/commandExecution/requestApproval',
          'item/fileChange/requestApproval'
        )),
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        reason TEXT,
        command TEXT,
        cwd TEXT,
        grant_root TEXT,
        params_json TEXT NOT NULL CHECK (json_valid(params_json)),
        status TEXT NOT NULL CHECK (status IN ('pending', 'resolving', 'approved', 'declined', 'cancelled')),
        resolution TEXT CHECK (resolution IS NULL OR resolution IN ('approve', 'decline')),
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT
      ) STRICT;
      CREATE INDEX idx_approval_requests_pending
        ON approval_requests(status, created_at, approval_id);
      CREATE INDEX idx_approval_requests_thread
        ON approval_requests(thread_id, status, created_at, approval_id);
    `
  },
  {
    version: 7,
    name: "source_reply_routing_p0",
    sql: `
      CREATE TABLE conversation_aliases (
        alias TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        instance_id TEXT,
        source_conversation_id TEXT NOT NULL,
        project_id TEXT,
        project_name TEXT,
        task_id TEXT,
        task_title TEXT,
        capability TEXT NOT NULL CHECK (capability IN ('interactive', 'push_only', 'system')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider, source_conversation_id)
      ) STRICT;
      CREATE INDEX idx_conversation_aliases_updated
        ON conversation_aliases(updated_at DESC, alias);

      CREATE TABLE channel_message_registry (
        registry_id TEXT PRIMARY KEY,
        channel TEXT NOT NULL CHECK (channel IN ('weixin', 'feishu', 'qq')),
        channel_account_id TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        channel_message_id TEXT NOT NULL,
        gateway_message_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        source_conversation_id TEXT,
        source_alias TEXT REFERENCES conversation_aliases(alias),
        task_id TEXT,
        capability TEXT NOT NULL CHECK (capability IN ('interactive', 'push_only', 'system')),
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'system')),
        created_at TEXT NOT NULL,
        UNIQUE(channel, channel_account_id, peer_id, channel_message_id)
      ) STRICT;
      CREATE INDEX idx_channel_message_registry_scope
        ON channel_message_registry(channel, channel_account_id, peer_id, created_at DESC);
      CREATE INDEX idx_channel_message_registry_alias
        ON channel_message_registry(channel, channel_account_id, peer_id, source_alias, created_at DESC);

      CREATE TABLE active_conversations (
        channel TEXT NOT NULL CHECK (channel IN ('weixin', 'feishu', 'qq')),
        channel_account_id TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        conversation_alias TEXT NOT NULL REFERENCES conversation_aliases(alias),
        source_conversation_id TEXT NOT NULL,
        updated_by TEXT NOT NULL CHECK (updated_by IN ('explicit_switch', 'reply_reference', 'admin')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(channel, channel_account_id, peer_id)
      ) STRICT;
      CREATE INDEX idx_active_conversations_updated
        ON active_conversations(updated_at DESC);
    `
  },
  {
    version: 8,
    name: "turn_result_checkpoint",
    sql: `
      ALTER TABLE turns ADD COLUMN result_json TEXT
        CHECK (result_json IS NULL OR json_valid(result_json));
    `
  }
];
