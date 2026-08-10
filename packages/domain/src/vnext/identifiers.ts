const channelNames = ["weixin", "feishu", "qq"] as const;
const conversationScopes = ["c2c", "group"] as const;

export type ChannelName = (typeof channelNames)[number];
export type ConversationScope = (typeof conversationScopes)[number];
export type ChannelAccountId = string & { readonly __brand: "ChannelAccountId" };
export type ConversationSpaceId = string & { readonly __brand: "ConversationSpaceId" };

export type ParsedChannelAccountId = {
  channel: ChannelName;
  accountId: string;
};

export type ParsedConversationSpaceId = ParsedChannelAccountId & {
  channelAccountId: ChannelAccountId;
  scope: ConversationScope;
  providerConversationId: string;
};

export function createChannelAccountId(
  channel: ChannelName,
  accountId: string
): ChannelAccountId {
  if (!channelNames.includes(channel)) {
    throw new IdentifierError("channel", `Unsupported channel '${String(channel)}'`);
  }

  const normalizedAccountId = normalizeIdentifierPart("accountId", accountId);
  if (normalizedAccountId.includes("::")) {
    throw new IdentifierError("accountId", "Channel account id cannot contain '::'");
  }

  return `${channel}:${normalizedAccountId}` as ChannelAccountId;
}

export function parseChannelAccountId(value: string): ParsedChannelAccountId {
  const normalized = normalizeWholeIdentifier("channelAccountId", value);
  const separator = normalized.indexOf(":");
  if (separator <= 0) {
    throw new IdentifierError("channelAccountId", "Expected '<channel>:<accountId>'");
  }

  const channel = normalized.slice(0, separator);
  const accountId = normalized.slice(separator + 1);
  if (!isChannelName(channel)) {
    throw new IdentifierError("channelAccountId", `Unsupported channel '${channel}'`);
  }

  const canonical = createChannelAccountId(channel, accountId);
  if (canonical !== normalized) {
    throw new IdentifierError("channelAccountId", "Identifier is not canonical");
  }

  return { channel, accountId };
}

export function createConversationSpaceId(
  channelAccountId: ChannelAccountId,
  scope: ConversationScope,
  providerConversationId: string
): ConversationSpaceId {
  parseChannelAccountId(channelAccountId);
  if (!conversationScopes.includes(scope)) {
    throw new IdentifierError("scope", `Unsupported conversation scope '${String(scope)}'`);
  }

  const normalizedProviderId = normalizeIdentifierPart(
    "providerConversationId",
    providerConversationId
  );
  if (normalizedProviderId.includes("::")) {
    throw new IdentifierError(
      "providerConversationId",
      "Provider conversation id cannot contain '::'"
    );
  }

  return `${channelAccountId}::${scope}:${normalizedProviderId}` as ConversationSpaceId;
}

export function parseConversationSpaceId(value: string): ParsedConversationSpaceId {
  const normalized = normalizeWholeIdentifier("spaceId", value);
  const separator = normalized.indexOf("::");
  if (separator <= 0) {
    throw new IdentifierError(
      "spaceId",
      "Expected '<channelAccountId>::<scope>:<providerConversationId>'"
    );
  }

  const rawChannelAccountId = normalized.slice(0, separator);
  const rawConversation = normalized.slice(separator + 2);
  const scopeSeparator = rawConversation.indexOf(":");
  if (scopeSeparator <= 0) {
    throw new IdentifierError("spaceId", "Conversation scope or provider id is missing");
  }

  const scope = rawConversation.slice(0, scopeSeparator);
  const providerConversationId = rawConversation.slice(scopeSeparator + 1);
  if (!isConversationScope(scope)) {
    throw new IdentifierError("spaceId", `Unsupported conversation scope '${scope}'`);
  }

  const parsedAccount = parseChannelAccountId(rawChannelAccountId);
  const channelAccountId = createChannelAccountId(
    parsedAccount.channel,
    parsedAccount.accountId
  );
  const canonical = createConversationSpaceId(
    channelAccountId,
    scope,
    providerConversationId
  );
  if (canonical !== normalized) {
    throw new IdentifierError("spaceId", "Identifier is not canonical");
  }

  return {
    ...parsedAccount,
    channelAccountId,
    scope,
    providerConversationId
  };
}

export class IdentifierError extends Error {
  readonly reason = "INVALID_IDENTIFIER";

  constructor(readonly field: string, message: string) {
    super(message);
    this.name = "IdentifierError";
  }
}

function normalizeIdentifierPart(field: string, value: string): string {
  if (typeof value !== "string") {
    throw new IdentifierError(field, `${field} must be a string`);
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new IdentifierError(field, `${field} cannot be empty`);
  }
  if (/\s/.test(normalized)) {
    throw new IdentifierError(field, `${field} cannot contain whitespace`);
  }

  return normalized;
}

function normalizeWholeIdentifier(field: string, value: string): string {
  const normalized = normalizeIdentifierPart(field, value);
  if (normalized !== value) {
    throw new IdentifierError(field, `${field} cannot contain surrounding whitespace`);
  }
  return normalized;
}

function isChannelName(value: string): value is ChannelName {
  return channelNames.includes(value as ChannelName);
}

function isConversationScope(value: string): value is ConversationScope {
  return conversationScopes.includes(value as ConversationScope);
}
