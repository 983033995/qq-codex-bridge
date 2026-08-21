import type { InboundMessage, MediaArtifact } from "../../../domain/src/message.js";
import { buildPeerKey, buildSessionKey } from "../../../orchestrator/src/session-key.js";

export function normalizeC2CMessage(
  event: {
    id: string;
    content: string;
    timestamp: string;
    author: { user_openid: string };
    reply_to_message_id?: string;
    message_reference?: { message_id?: string };
  },
  accountKey: string,
  mediaArtifacts: MediaArtifact[] = []
): InboundMessage {
  const peerKey = buildPeerKey({
    chatType: "c2c",
    peerId: event.author.user_openid
  });

  return {
    messageId: event.id,
    accountKey,
    sessionKey: buildSessionKey({ accountKey, peerKey }),
    peerKey,
    chatType: "c2c",
    senderId: event.author.user_openid,
    text: event.content,
    ...(mediaArtifacts.length > 0 ? { mediaArtifacts } : {}),
    ...replyToMessageId(event),
    receivedAt: event.timestamp
  };
}

export function normalizeGroupMessage(
  event: {
    id: string;
    content: string;
    timestamp: string;
    group_openid: string;
    author: { member_openid: string };
    reply_to_message_id?: string;
    message_reference?: { message_id?: string };
  },
  accountKey: string,
  mediaArtifacts: MediaArtifact[] = []
): InboundMessage {
  const peerKey = buildPeerKey({
    chatType: "group",
    peerId: event.group_openid
  });

  return {
    messageId: event.id,
    accountKey,
    sessionKey: buildSessionKey({ accountKey, peerKey }),
    peerKey,
    chatType: "group",
    senderId: event.author.member_openid,
    text: event.content,
    ...(mediaArtifacts.length > 0 ? { mediaArtifacts } : {}),
    ...replyToMessageId(event),
    receivedAt: event.timestamp
  };
}

function replyToMessageId(event: {
  reply_to_message_id?: string;
  message_reference?: { message_id?: string };
}): { replyToMessageId: string } | Record<string, never> {
  const id = event.reply_to_message_id?.trim() || event.message_reference?.message_id?.trim();
  return id ? { replyToMessageId: id } : {};
}
