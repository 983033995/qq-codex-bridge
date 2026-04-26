import type { DeliveryRecord, OutboundDraft } from "../../../domain/src/message.js";
import type { ChatEgressPort } from "../../../ports/src/chat.js";
import type { WeixinHttpClient } from "./weixin-http-client.js";
import { buildMediaArtifactFromReference, parseQqMediaSegments } from "../../qq/src/qq-media-parser.js";

const WEIXIN_TEXT_SEGMENT_MAX_LENGTH = 1800;

export class WeixinSender implements ChatEgressPort {
  constructor(
    private readonly apiClient?: Pick<WeixinHttpClient, "sendMessage">
  ) {}

  async deliver(draft: OutboundDraft): Promise<DeliveryRecord> {
    const providerMessageId = await this.deliverThroughApiClient(draft);

    return {
      jobId: draft.draftId,
      sessionKey: draft.sessionKey,
      providerMessageId,
      deliveredAt: draft.createdAt
    };
  }

  private async deliverThroughApiClient(draft: OutboundDraft): Promise<string | null> {
    if (!this.apiClient) {
      return null;
    }

    const target = parseSessionTarget(draft.sessionKey);
    const parsedArtifacts = parseQqMediaSegments(draft.text)
      .filter((segment) => segment.type === "media")
      .map((segment) => buildMediaArtifactFromReference(segment.reference));
    const mediaArtifacts = dedupeArtifacts([...(draft.mediaArtifacts ?? []), ...parsedArtifacts]);
    const content = extractTextContent(draft.text);
    const segments = buildWeixinOutboundSegments({
      peerId: target.peerId,
      chatType: target.chatType,
      accountKey: target.accountKey,
      accountId: target.accountId,
      content,
      mediaArtifacts,
      replyToMessageId: draft.replyToMessageId
    });

    let lastProviderMessageId: string | null = null;
    for (const segment of segments) {
      lastProviderMessageId = await this.apiClient.sendMessage(segment);
    }

    return lastProviderMessageId;
  }
}

function buildWeixinOutboundSegments(input: {
  peerId: string;
  chatType: "c2c" | "group";
  accountKey: string;
  accountId: string;
  content: string;
  mediaArtifacts: NonNullable<OutboundDraft["mediaArtifacts"]>;
  replyToMessageId?: string;
}): Array<{
  peerId: string;
  chatType: "c2c" | "group";
  content?: string;
  mediaArtifacts?: NonNullable<OutboundDraft["mediaArtifacts"]>;
  replyToMessageId?: string;
}> {
  const segments: Array<{
    peerId: string;
    chatType: "c2c" | "group";
    accountKey: string;
    accountId: string;
    content?: string;
    mediaArtifacts?: NonNullable<OutboundDraft["mediaArtifacts"]>;
    replyToMessageId?: string;
  }> = [];

  for (const contentSegment of splitWeixinTextContent(input.content)) {
    segments.push({
      peerId: input.peerId,
      chatType: input.chatType,
      accountKey: input.accountKey,
      accountId: input.accountId,
      content: contentSegment,
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {})
    });
  }

  for (const artifact of input.mediaArtifacts) {
    segments.push({
      peerId: input.peerId,
      chatType: input.chatType,
      accountKey: input.accountKey,
      accountId: input.accountId,
      mediaArtifacts: [artifact],
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {})
    });
  }

  return segments;
}

function splitWeixinTextContent(
  content: string,
  maxLength = WEIXIN_TEXT_SEGMENT_MAX_LENGTH
): string[] {
  const text = content.trim();
  if (!text) {
    return [];
  }
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let current = "";

  const flushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed) {
      chunks.push(trimmed);
    }
    current = "";
  };

  const appendPart = (part: string) => {
    if (!part) {
      return;
    }
    if (current && current.length + part.length > maxLength) {
      flushCurrent();
    }
    if (part.length <= maxLength) {
      current += part;
      return;
    }

    for (const piece of splitOversizedPart(part, maxLength)) {
      if (current && current.length + piece.length > maxLength) {
        flushCurrent();
      }
      if (piece.length > maxLength) {
        flushCurrent();
        chunks.push(piece.trim());
      } else {
        current += piece;
      }
    }
  };

  for (const part of splitIntoParagraphParts(text)) {
    appendPart(part);
  }
  flushCurrent();

  return chunks;
}

function splitIntoParagraphParts(text: string): string[] {
  const rawParts = text.split(/(\n{2,})/);
  const parts: string[] = [];

  for (let index = 0; index < rawParts.length; index += 2) {
    const body = rawParts[index] ?? "";
    const separator = rawParts[index + 1] ?? "";
    if (body || separator) {
      parts.push(`${body}${separator}`);
    }
  }

  return parts;
}

function splitOversizedPart(part: string, maxLength: number): string[] {
  const lines = part.split(/(?<=\n)/);
  const pieces: string[] = [];
  let current = "";

  const flushCurrent = () => {
    if (current) {
      pieces.push(current);
      current = "";
    }
  };

  for (const line of lines) {
    if (line.length > maxLength) {
      flushCurrent();
      pieces.push(...splitByLength(line, maxLength));
      continue;
    }
    if (current && current.length + line.length > maxLength) {
      flushCurrent();
    }
    current += line;
  }

  flushCurrent();
  return pieces;
}

function splitByLength(text: string, maxLength: number): string[] {
  const chars = Array.from(text);
  const chunks: string[] = [];
  for (let index = 0; index < chars.length; index += maxLength) {
    chunks.push(chars.slice(index, index + maxLength).join(""));
  }
  return chunks;
}

function extractTextContent(text: string): string {
  const parts = parseQqMediaSegments(text)
    .filter((segment) => segment.type === "text")
    .map((segment) => segment.text)
    .join("")
    .trim();
  return parts;
}

function dedupeArtifacts(
  artifacts: NonNullable<OutboundDraft["mediaArtifacts"]>
): NonNullable<OutboundDraft["mediaArtifacts"]> {
  const seen = new Set<string>();
  const deduped = [];

  for (const artifact of artifacts) {
    const key = [
      artifact.kind,
      artifact.localPath || "",
      artifact.sourceUrl || "",
      artifact.originalName || ""
    ].join("::");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(artifact);
  }

  return deduped;
}

function parseSessionTarget(sessionKey: string): {
  accountKey: string;
  accountId: string;
  chatType: "c2c" | "group";
  peerId: string;
} {
  const parts = sessionKey.split("::");
  const accountKey = parts.at(0) ?? "";
  const scope = parts.at(-1) ?? "";
  const segments = scope.split(":");
  const chatType = segments.at(-2);
  const peerId = segments.at(-1);

  if (!accountKey || (chatType !== "c2c" && chatType !== "group") || !peerId) {
    throw new Error(`Unable to parse channel session key: ${sessionKey}`);
  }

  return {
    accountKey,
    accountId: accountKey.startsWith("weixin:") ? accountKey.slice("weixin:".length) : accountKey,
    chatType,
    peerId
  };
}
