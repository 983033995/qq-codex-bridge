import type { InboundMessage } from "../../../domain/src/message.js";

export type WeixinWebhookPayload = {
  accountKey?: string;
  chatType?: "c2c" | "group";
  senderId?: string;
  peerId?: string;
  messageId?: string;
  text?: string;
  receivedAt?: string;
};

export function normalizeWeixinInboundMessage(
  payload: WeixinWebhookPayload,
  options: {
    accountKey: string;
  }
): InboundMessage {
  const chatType = payload.chatType === "group" ? "group" : "c2c";
  const senderId = String(payload.senderId ?? "").trim();
  const peerId = String(payload.peerId ?? senderId).trim();
  const messageId = String(payload.messageId ?? "").trim();
  const text = String(payload.text ?? "").trim();
  const receivedAt = normalizeTimestamp(payload.receivedAt);

  if (!senderId || !peerId || !messageId || !text) {
    throw new Error("invalid weixin webhook payload");
  }

  return {
    messageId,
    accountKey: options.accountKey,
    sessionKey: buildSessionKey(options.accountKey, chatType, peerId),
    peerKey: buildPeerKey(chatType, peerId),
    chatType,
    senderId,
    text,
    receivedAt
  };
}

function buildSessionKey(accountKey: string, chatType: "c2c" | "group", peerId: string): string {
  return `${accountKey}::wx:${chatType}:${peerId}`;
}

function buildPeerKey(chatType: "c2c" | "group", peerId: string): string {
  return `wx:${chatType}:${peerId}`;
}

function normalizeTimestamp(value?: string): string {
  const input = String(value ?? "").trim();
  if (!input) {
    return new Date().toISOString();
  }

  const parsed = Date.parse(input);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}
