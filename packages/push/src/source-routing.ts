import type { ConversationResolver } from "../../application/src/conversation-resolver.js";
import type {
  ConversationAlias,
  SourceIdentity
} from "../../domain/src/vnext/index.js";
import { createChannelAccountId } from "../../domain/src/vnext/index.js";
import type {
  ChannelMessageRegistryRepository,
  ChannelMessageScope
} from "../../ports/src/vnext/index.js";
import type {
  PushSourceRoutingPort,
  PushTarget
} from "../../ports/src/push.js";

/**
 * Persists Push source identity in the vNext routing data plane.
 *
 * The MCP supplied alias is deliberately not part of this adapter's input
 * contract. Aliases are Gateway-owned identifiers and are allocated from the
 * provider/source conversation pair instead.
 */
export class PersistentPushSourceRouting implements PushSourceRoutingPort {
  constructor(private readonly deps: {
    resolver: Pick<ConversationResolver, "ensureAlias">;
    registry: ChannelMessageRegistryRepository;
    nextId: () => string;
  }) {}

  async resolve(input: Parameters<PushSourceRoutingPort["resolve"]>[0]): Promise<SourceIdentity> {
    const source = normalizeSource(input.source, input.sourceConversationId);
    const alias = await this.deps.resolver.ensureAlias({
      provider: source.provider,
      instanceId: source.instanceId ?? null,
      sourceConversationId: input.sourceConversationId,
      ...(source.projectId ? { projectId: source.projectId } : {}),
      ...(source.projectName ? { projectName: source.projectName } : {}),
      ...(source.taskId ? { taskId: source.taskId } : {}),
      ...(source.taskTitle ? { taskTitle: source.taskTitle } : {}),
      capability: source.capability
    });
    return sourceIdentity(alias);
  }

  async record(input: Parameters<PushSourceRoutingPort["record"]>[0]): Promise<void> {
    const scope = {
      channel: input.target.channel,
      channelAccountId: createChannelAccountId(
        input.target.channel,
        accountPart(input.target.channel, input.target.accountKey)
      ),
      peerId: input.target.providerTargetId
    } satisfies ChannelMessageScope;
    await this.deps.registry.save({
      registryId: this.deps.nextId(),
      ...scope,
      channelMessageId: input.providerMessageId,
      gatewayMessageId: input.pushId,
      provider: input.source.provider,
      sourceConversationId: input.source.conversationId ?? null,
      sourceAlias: input.source.conversationAlias ?? null,
      taskId: input.source.taskId ?? null,
      capability: input.source.capability,
      direction: "outbound",
      createdAt: input.createdAt
    });
  }
}

function normalizeSource(source: SourceIdentity, sourceConversationId: string): SourceIdentity {
  const provider = normalizeProvider(source.provider);
  return {
    provider,
    ...(source.instanceId ? { instanceId: source.instanceId } : {}),
    conversationId: sourceConversationId,
    ...(source.projectId ? { projectId: source.projectId } : {}),
    ...(source.projectName ? { projectName: source.projectName } : {}),
    ...(source.taskId ? { taskId: source.taskId } : {}),
    ...(source.taskTitle ? { taskTitle: source.taskTitle } : {}),
    capability: provider === "system"
      ? "system"
      : provider === "codex"
        ? "interactive"
        : "push_only"
  };
}

function normalizeProvider(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized === "agent" || normalized === "unknown" || normalized === "thread-command"
    ? "system"
    : normalized || "system";
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

function accountPart(channel: PushTarget["channel"], accountKey: string): string {
  const normalized = accountKey.trim();
  if (normalized.startsWith(`${channel}:`)) return normalized.slice(channel.length + 1);
  if (channel === "qq" && normalized.startsWith("qqbot:")) {
    return normalized.slice("qqbot:".length);
  }
  return normalized;
}
