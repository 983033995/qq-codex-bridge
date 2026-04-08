import type { InboundMessage } from "../../../domain/src/message.js";
import { buildPeerKey, buildSessionKey } from "../../../orchestrator/src/session-key.js";

export function normalizeC2CMessage(
  event: {
    id: string;
    content: string;
    timestamp: string;
    author: { user_openid: string };
  },
  accountKey: string
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
    receivedAt: event.timestamp
  };
}
