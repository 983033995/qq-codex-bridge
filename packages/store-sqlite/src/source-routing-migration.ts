type SourceRoutingDatabase = {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  };
  transaction<T>(work: () => T): {
    (): T;
    immediate(): T;
  };
};

/**
 * Copies source-routing rows from an older vNext database into the dedicated
 * routing database used by both the vNext runtime and the legacy Push worker.
 * Existing rows are preserved so repeated starts cannot overwrite newer Push
 * observations with stale rows from the old database.
 */
export function migrateSourceRoutingData(
  source: SourceRoutingDatabase,
  target: SourceRoutingDatabase
): void {
  if (source === target || !hasSourceRoutingTables(source)) return;

  const aliases = source.prepare(`
    SELECT alias, provider, instance_id, source_conversation_id,
      project_id, project_name, task_id, task_title, capability,
      created_at, updated_at
    FROM conversation_aliases
  `).all() as ConversationAliasRow[];
  const registry = source.prepare(`
    SELECT registry_id, channel, channel_account_id, peer_id,
      channel_message_id, gateway_message_id, provider,
      source_conversation_id, source_alias, task_id, capability,
      direction, created_at
    FROM channel_message_registry
  `).all() as ChannelMessageRegistryRow[];
  const active = source.prepare(`
    SELECT channel, channel_account_id, peer_id, conversation_alias,
      source_conversation_id, updated_by, updated_at
    FROM active_conversations
  `).all() as ActiveConversationRow[];

  target.transaction(() => {
    const insertAlias = target.prepare(`
      INSERT OR IGNORE INTO conversation_aliases (
        alias, provider, instance_id, source_conversation_id,
        project_id, project_name, task_id, task_title, capability,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of aliases) {
      insertAlias.run(
        row.alias,
        row.provider,
        row.instance_id,
        row.source_conversation_id,
        row.project_id,
        row.project_name,
        row.task_id,
        row.task_title,
        row.capability,
        row.created_at,
        row.updated_at
      );
    }

    const insertRegistry = target.prepare(`
      INSERT OR IGNORE INTO channel_message_registry (
        registry_id, channel, channel_account_id, peer_id,
        channel_message_id, gateway_message_id, provider,
        source_conversation_id, source_alias, task_id, capability,
        direction, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of registry) {
      insertRegistry.run(
        row.registry_id,
        row.channel,
        row.channel_account_id,
        row.peer_id,
        row.channel_message_id,
        row.gateway_message_id,
        row.provider,
        row.source_conversation_id,
        row.source_alias,
        row.task_id,
        row.capability,
        row.direction,
        row.created_at
      );
    }

    const insertActive = target.prepare(`
      INSERT OR IGNORE INTO active_conversations (
        channel, channel_account_id, peer_id, conversation_alias,
        source_conversation_id, updated_by, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of active) {
      insertActive.run(
        row.channel,
        row.channel_account_id,
        row.peer_id,
        row.conversation_alias,
        row.source_conversation_id,
        row.updated_by,
        row.updated_at
      );
    }
  }).immediate();
}

function hasSourceRoutingTables(database: SourceRoutingDatabase): boolean {
  const rows = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('conversation_aliases', 'channel_message_registry', 'active_conversations')
  `).all() as Array<{ name?: unknown }>;
  return new Set(rows.map((row) => row.name)).size === 3;
}

type ConversationAliasRow = {
  alias: string;
  provider: string;
  instance_id: string | null;
  source_conversation_id: string;
  project_id: string | null;
  project_name: string | null;
  task_id: string | null;
  task_title: string | null;
  capability: string;
  created_at: string;
  updated_at: string;
};

type ChannelMessageRegistryRow = {
  registry_id: string;
  channel: string;
  channel_account_id: string;
  peer_id: string;
  channel_message_id: string;
  gateway_message_id: string;
  provider: string;
  source_conversation_id: string | null;
  source_alias: string | null;
  task_id: string | null;
  capability: string;
  direction: string;
  created_at: string;
};

type ActiveConversationRow = {
  channel: string;
  channel_account_id: string;
  peer_id: string;
  conversation_alias: string;
  source_conversation_id: string;
  updated_by: string;
  updated_at: string;
};
