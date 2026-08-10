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
  }
];
