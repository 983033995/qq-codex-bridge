import { createHash } from "node:crypto";
import type { MessageContent, SourceIdentity } from "../../domain/src/vnext/index.js";
import type { PushPayload, PushSource } from "../../ports/src/push.js";

export function normalizePushSource(source: PushSource | undefined, fallbackId: string): SourceIdentity {
  if (typeof source === "object" && source !== null) {
    const provider = normalizeProvider(source.provider);
    return {
      provider,
      ...(source.instanceId ? { instanceId: source.instanceId } : {}),
      ...(source.conversationId ? { conversationId: source.conversationId } : {}),
      ...(source.projectId ? { projectId: source.projectId } : {}),
      ...(source.projectName ? { projectName: source.projectName } : {}),
      ...(source.taskId ? { taskId: source.taskId } : {}),
      ...(source.taskTitle ? { taskTitle: source.taskTitle } : {}),
      capability: defaultCapability(provider)
    };
  }

  const provider = normalizeProvider(source ?? "unknown");
  return {
    provider,
    conversationId: fallbackId,
    capability: defaultCapability(provider)
  };
}

export function withFallbackConversationAlias(
  source: SourceIdentity,
  sourceConversationId: string
): SourceIdentity {
  if (source.conversationAlias) return source;
  const prefix = providerPrefix(source.provider);
  const digest = createHash("sha256")
    .update(`${source.provider}\0${sourceConversationId}`)
    .digest("hex")
    .toUpperCase();
  return { ...source, conversationAlias: `#${prefix}${digest.slice(0, 3)}` };
}

export function formatPushPayload(
  payload: PushPayload,
  source: SourceIdentity
): PushPayload {
  const content: MessageContent = {
    text: payload.message.text,
    mentions: [],
    attachments: [],
    format: payload.message.format,
    source
  };
  const formatted = formatSourceText(content);
  return {
    ...payload,
    message: { ...payload.message, text: formatted },
    metadata: { ...payload.metadata, source }
  };
}

export function formatSourceText(content: MessageContent): string {
  const source = content.source;
  if (!source) return content.text;
  const provider = source.provider === "codex"
    ? "Codex"
    : source.provider === "claude"
      ? "Claude"
      : source.provider === "opencode"
        ? "OpenCode"
        : source.provider === "system"
          ? "OmniAgent"
          : source.provider;
  const title = source.taskTitle ?? source.projectName ?? null;
  const body = content.text.trim();
  const header = `【${provider}${title ? ` · ${title}` : ""}】`;
  return [header, body, source.conversationAlias].filter(Boolean).join("\n\n");
}

function normalizeProvider(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "agent" || normalized === "unknown" || normalized === "thread-command") {
    return "system";
  }
  return normalized || "system";
}

function defaultCapability(provider: string): SourceIdentity["capability"] {
  if (provider === "system") return "system";
  if (provider === "codex") return "interactive";
  return "push_only";
}

function providerPrefix(provider: string): string {
  if (provider === "codex") return "C";
  if (provider === "claude") return "A";
  if (provider === "opencode") return "O";
  if (provider === "system") return "S";
  return (provider.match(/[a-z]/i)?.[0] ?? "X").toUpperCase();
}
