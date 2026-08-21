import { createHash } from "node:crypto";
import type {
  ActiveConversation,
  ChannelMessageRegistryEntry,
  ConversationAlias,
  ConversationSpace,
  InboundEnvelope,
  SourceIdentity,
  ThreadBinding
} from "../../domain/src/vnext/index.js";
import type {
  ActiveConversationRepository,
  ChannelMessageRegistryRepository,
  ConversationAliasRepository
} from "../../ports/src/vnext/index.js";

export type ConversationResolverDependencies = {
  aliases: ConversationAliasRepository;
  registry: ChannelMessageRegistryRepository;
  active: ActiveConversationRepository;
};

export type ConversationResolution =
  | {
      kind: "interactive";
      alias: ConversationAlias;
      source: SourceIdentity;
      binding: ThreadBinding;
      matchedBy: "reply_reference" | "explicit_alias" | "active_conversation";
    }
  | {
      kind: "push_only";
      alias: ConversationAlias;
      source: SourceIdentity;
      message: string;
      matchedBy: "reply_reference" | "explicit_alias" | "active_conversation";
    }
  | { kind: "clarify"; text: string };

export type ConversationSummary = {
  alias: string;
  provider: string;
  title: string;
  projectName: string | null;
  capability: ConversationAlias["capability"];
  updatedAt: string;
  active: boolean;
};

export class ConversationResolver {
  constructor(private readonly deps: ConversationResolverDependencies & { now?: () => string }) {}

  async getActiveConversation(input: {
    space: ConversationSpace;
  }): Promise<ActiveConversation | null> {
    return this.deps.active.get(scopeOf(input.space));
  }

  async ensureActiveForBinding(input: {
    space: ConversationSpace;
    binding: ThreadBinding;
  }): Promise<ConversationAlias> {
    const alias = (await this.ensureForBinding({ binding: input.binding })).alias;
    const scope = scopeOf(input.space);
    const current = await this.deps.active.get(scope);
    if (!current) {
      await this.deps.active.save({
        ...scope,
        conversationAlias: alias.alias,
        sourceConversationId: alias.sourceConversationId,
        updatedBy: "admin",
        updatedAt: this.now()
      });
    }
    return alias;
  }

  async setActiveForBinding(input: {
    space: ConversationSpace;
    binding: ThreadBinding;
    updatedBy: ActiveConversation["updatedBy"];
  }): Promise<ConversationAlias> {
    const alias = (await this.ensureForBinding({ binding: input.binding })).alias;
    const scope = scopeOf(input.space);
    await this.deps.active.save({
      ...scope,
      conversationAlias: alias.alias,
      sourceConversationId: alias.sourceConversationId,
      updatedBy: input.updatedBy,
      updatedAt: this.now()
    });
    return alias;
  }

  async resolveInboundTarget(input: {
    space: ConversationSpace;
    message: InboundEnvelope;
    explicitAlias?: string;
  }): Promise<ConversationResolution | null> {
    const scope = scopeOf(input.space);
    const replyTo = input.message.content.replyToProviderMessageId?.trim();
    if (replyTo) {
      const entry = await this.deps.registry.getByChannelMessage({
        ...scope,
        channelMessageId: replyTo
      });
      if (!entry?.sourceAlias) {
        return { kind: "clarify", text: "我无法确认你引用的消息属于哪个任务。请发送 /sessions 选择目标会话。" };
      }
      return this.resolveAlias(input.space.spaceId, scope, entry.sourceAlias, "reply_reference");
    }

    const explicitAlias = normalizeAlias(input.explicitAlias ?? extractAlias(input.message.content.text));
    if (explicitAlias) {
      return this.resolveAlias(input.space.spaceId, scope, explicitAlias, "explicit_alias");
    }

    const current = await this.deps.active.get(scope);
    if (!current) return null;
    return this.resolveAlias(input.space.spaceId, scope, current.conversationAlias, "active_conversation");
  }

  async setActiveConversation(input: {
    space: ConversationSpace;
    alias: string;
    updatedBy: ActiveConversation["updatedBy"];
  }): Promise<ConversationAlias> {
    const scope = scopeOf(input.space);
    const alias = await this.requireAccessibleAlias(scope, input.alias);
    const active: ActiveConversation = {
      ...scope,
      conversationAlias: alias.alias,
      sourceConversationId: alias.sourceConversationId,
      updatedBy: input.updatedBy,
      updatedAt: this.now()
    };
    await this.deps.active.save(active);
    return alias;
  }

  async listRecentConversations(input: {
    space: ConversationSpace;
    limit?: number;
  }): Promise<ConversationSummary[]> {
    const scope = scopeOf(input.space);
    const active = await this.deps.active.get(scope);
    const entries = await this.deps.registry.listByScope({
      ...scope,
      limit: Math.min(input.limit ?? 20, 200)
    });
    const aliases = new Map<string, ConversationAlias>();
    for (const entry of entries) {
      if (!entry.sourceAlias) continue;
      const alias = await this.deps.aliases.get(entry.sourceAlias);
      if (alias) aliases.set(alias.alias, alias);
    }
    if (active) {
      const alias = await this.deps.aliases.get(active.conversationAlias);
      if (alias) aliases.set(alias.alias, alias);
    }
    return [...aliases.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.alias.localeCompare(right.alias))
      .slice(0, Math.min(input.limit ?? 20, 200))
      .map((alias) => ({
        alias: alias.alias,
        provider: alias.provider,
        title: alias.taskTitle ?? alias.projectName ?? alias.sourceConversationId,
        projectName: alias.projectName,
        capability: alias.capability,
        updatedAt: alias.updatedAt,
        active: active?.conversationAlias === alias.alias
      }));
  }

  async ensureForBinding(input: {
    binding: ThreadBinding;
    projectName?: string | null;
    taskId?: string | null;
    taskTitle?: string | null;
  }): Promise<{ alias: ConversationAlias; source: SourceIdentity }> {
    const alias = await this.ensureAlias({
      provider: "codex",
      sourceConversationId: input.binding.threadId,
      ...(input.projectName !== undefined ? { projectName: input.projectName } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      taskTitle: input.taskTitle ?? input.binding.threadTitle,
      capability: "interactive"
    });
    return { alias, source: sourceIdentity(alias) };
  }

  async ensureAlias(input: {
    provider: string;
    instanceId?: string | null;
    sourceConversationId: string;
    projectId?: string | null;
    projectName?: string | null;
    taskId?: string | null;
    taskTitle?: string | null;
    capability: ConversationAlias["capability"];
  }): Promise<ConversationAlias> {
    const now = this.now();
    const existing = await this.deps.aliases.findBySource({
      provider: input.provider,
      sourceConversationId: input.sourceConversationId
    });
    if (existing) {
      const updated = {
        ...existing,
        ...nullableSourceFields(existing, input),
        updatedAt: now
      };
      await this.deps.aliases.save(updated);
      return updated;
    }

    const digest = createHash("sha256")
      .update(`${input.provider}\0${input.sourceConversationId}`)
      .digest("hex");
    for (let offset = 0; offset < digest.length - 4; offset += 1) {
      const candidate = `#${providerPrefix(input.provider)}${base32(digest.slice(offset, offset + 8)).slice(-3)}`;
      const collision = await this.deps.aliases.get(candidate);
      if (collision && (
        collision.provider !== input.provider
        || collision.sourceConversationId !== input.sourceConversationId
      )) {
        continue;
      }
      const alias: ConversationAlias = {
        alias: candidate,
        provider: input.provider,
        instanceId: input.instanceId ?? null,
        sourceConversationId: input.sourceConversationId,
        projectId: input.projectId ?? null,
        projectName: input.projectName ?? null,
        taskId: input.taskId ?? null,
        taskTitle: input.taskTitle ?? null,
        capability: input.capability,
        createdAt: now,
        updatedAt: now
      };
      await this.deps.aliases.save(alias);
      return alias;
    }
    throw new Error(`Unable to allocate a unique conversation alias for '${input.sourceConversationId}'`);
  }

  async recordMessage(entry: ChannelMessageRegistryEntry): Promise<void> {
    await this.deps.registry.save(entry);
  }

  async getMessageByChannelMessage(input: {
    channel: ConversationSpace["channel"];
    channelAccountId: ConversationSpace["accountId"];
    peerId: string;
    channelMessageId: string;
  }): Promise<ChannelMessageRegistryEntry | null> {
    return this.deps.registry.getByChannelMessage(input);
  }

  async sourceForBinding(binding: ThreadBinding): Promise<SourceIdentity> {
    return (await this.ensureForBinding({ binding })).source;
  }

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private async resolveAlias(
    spaceId: ConversationSpace["spaceId"],
    scope: ReturnType<typeof scopeOf>,
    rawAlias: string,
    matchedBy: "reply_reference" | "explicit_alias" | "active_conversation"
  ): Promise<ConversationResolution> {
    const alias = await this.requireAccessibleAlias(scope, rawAlias).catch(() => null);
    if (!alias) {
      return { kind: "clarify", text: `没有找到 ${normalizeAlias(rawAlias) ?? rawAlias}。发送 /sessions 查看最近会话。` };
    }
    const source = sourceIdentity(alias);
    if (alias.capability === "push_only") {
      return {
        kind: "push_only",
        alias,
        source,
        matchedBy,
        message: `这条消息来自 ${providerLabel(alias.provider)} 的主动推送（${alias.alias}）。当前 v0.3 不能从该渠道直接继续这个会话。你可以切换到一个 Codex 会话，或在 ${providerLabel(alias.provider)} 中继续该任务。`
      };
    }
    return {
      kind: "interactive",
      alias,
      source,
      matchedBy,
      binding: virtualBinding(spaceId, scope, alias)
    };
  }

  private async requireAccessibleAlias(
    scope: ReturnType<typeof scopeOf>,
    rawAlias: string
  ): Promise<ConversationAlias> {
    const normalized = normalizeAlias(rawAlias);
    if (!normalized) throw new Error("Conversation alias is invalid");
    const alias = await this.deps.aliases.get(normalized);
    if (!alias) throw new Error(`Conversation alias '${normalized}' was not found`);
    const active = await this.deps.active.get(scope);
    if (active?.conversationAlias === alias.alias) return alias;
    const entries = await this.deps.registry.listByScope({ ...scope, limit: 200 });
    if (entries.some((entry) => entry.sourceAlias === alias.alias)) return alias;
    throw new Error(`Conversation alias '${normalized}' is not available in this channel scope`);
  }
}

function scopeOf(space: ConversationSpace) {
  return {
    channel: space.channel,
    channelAccountId: space.accountId,
    peerId: space.providerConversationId
  } as const;
}

function virtualBinding(
  spaceId: ConversationSpace["spaceId"],
  scope: ReturnType<typeof scopeOf>,
  alias: ConversationAlias
): ThreadBinding {
  const now = alias.updatedAt;
  return {
    bindingId: `alias:${alias.alias}`,
    spaceId,
    threadId: alias.sourceConversationId,
    threadTitle: alias.taskTitle ?? alias.projectName ?? alias.sourceConversationId,
    mode: "shared",
    status: "active",
    createdAt: now,
    updatedAt: now
  };
}

function sourceIdentity(alias: ConversationAlias): SourceIdentity {
  return {
    provider: alias.provider,
    ...(alias.instanceId ? { instanceId: alias.instanceId } : {}),
    conversationId: alias.sourceConversationId,
    conversationAlias: alias.alias,
    ...(alias.projectId ? { projectId: alias.projectId } : {}),
    ...(alias.projectName ? { projectName: alias.projectName } : {}),
    ...(alias.taskId ? { taskId: alias.taskId } : {}),
    ...(alias.taskTitle ? { taskTitle: alias.taskTitle } : {}),
    capability: alias.capability
  };
}

function nullableSourceFields(existing: ConversationAlias, input: {
  instanceId?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  taskId?: string | null;
  taskTitle?: string | null;
  capability: ConversationAlias["capability"];
}) {
  return {
    instanceId: input.instanceId === undefined ? existing.instanceId : input.instanceId,
    projectId: input.projectId === undefined ? existing.projectId : input.projectId,
    projectName: input.projectName === undefined ? existing.projectName : input.projectName,
    taskId: input.taskId === undefined ? existing.taskId : input.taskId,
    taskTitle: input.taskTitle === undefined ? existing.taskTitle : input.taskTitle,
    capability: input.capability
  };
}

export function stripConversationAlias(text: string, alias?: string): string {
  const aliasPattern = alias
    ? new RegExp(`(?:^|\\s)${escapeRegExp(normalizeAlias(alias) ?? alias)}(?=\\s|$)`, "i")
    : /(?:^|\s)#[A-Z][A-Z0-9]{2,4}(?=\s|$)/gi;
  return text
    .replace(aliasPattern, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}

function extractAlias(text: string): string | null {
  const match = /(?:^|\s)(#[CAOS][A-Z0-9]{2,4})(?=\s|$)/i.exec(text.trim());
  return match?.[1] ?? null;
}

function normalizeAlias(value: string | undefined | null): string | null {
  const normalized = value?.trim().toUpperCase() ?? "";
  if (!normalized) return null;
  const withHash = normalized.startsWith("#") ? normalized : `#${normalized}`;
  return /^#[A-Z][A-Z0-9]{2,4}$/.test(withHash) ? withHash : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function providerPrefix(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "codex") return "C";
  if (normalized === "claude") return "A";
  if (normalized === "opencode") return "O";
  if (normalized === "system") return "S";
  return (normalized.match(/[a-z]/)?.[0] ?? "X").toUpperCase();
}

function base32(hex: string): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let value = BigInt(`0x${hex}`);
  let result = "";
  for (let index = 0; index < 8; index += 1) {
    result = alphabet[Number(value & 31n)] + result;
    value >>= 5n;
  }
  return result;
}

function providerLabel(provider: string): string {
  return provider === "codex" ? "Codex" : provider === "claude" ? "Claude Code" : provider;
}
