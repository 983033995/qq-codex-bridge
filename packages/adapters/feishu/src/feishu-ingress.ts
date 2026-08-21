import type { InboundMessage } from "../../../domain/src/message.js";
import type { FeishuMessageEvent } from "./feishu-types.js";

type FeishuEventDispatcherLike = {
  register(handlers: {
    "im.message.receive_v1": (event: FeishuMessageEvent) => Promise<void> | void;
  }): unknown;
};

type FeishuWsClientLike = {
  start(options: { eventDispatcher: unknown }): Promise<void>;
  close(options?: { force?: boolean }): void;
};

export class FeishuIngress {
  private handler: ((message: InboundMessage) => Promise<void>) | null = null;
  private readonly seenMessages = new Map<string, number>();

  constructor(private readonly options: {
    accountKey: string;
    wsClient: FeishuWsClientLike;
    eventDispatcher: FeishuEventDispatcherLike;
    now?: () => number;
    onDispatchError?: (error: Error) => void;
    onIgnoredMessage?: (diagnostic: {
      reason: string;
      senderType: string;
      messageType: string;
      hasMessageId: boolean;
      hasChatId: boolean;
      hasSenderId: boolean;
      contentLength: number;
    }) => void;
  }) {
    options.eventDispatcher.register({
      "im.message.receive_v1": (event) => this.receive(event)
    });
  }

  onMessage(handler: (message: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  start(): Promise<void> {
    return this.options.wsClient.start({ eventDispatcher: this.options.eventDispatcher });
  }

  stop(): Promise<void> {
    this.options.wsClient.close({ force: true });
    return Promise.resolve();
  }

  private receive(event: FeishuMessageEvent): void {
    if (!this.handler) {
      this.reportIgnored("handler_unavailable", event);
      return;
    }
    if (isBotSender(event.sender.sender_type)) {
      this.reportIgnored("bot_sender", event);
      return;
    }
    const message = normalizeFeishuInbound(event, this.options.accountKey);
    if (!message) {
      this.reportIgnored("invalid_payload", event);
      return;
    }
    if (this.isDuplicate(message.messageId)) {
      this.reportIgnored("duplicate", event);
      return;
    }
    this.remember(message.messageId);
    void this.handler(message).catch((error) => {
      this.options.onDispatchError?.(
        error instanceof Error ? error : new Error(String(error))
      );
    });
  }

  private reportIgnored(reason: string, event: FeishuMessageEvent): void {
    this.options.onIgnoredMessage?.({
      reason,
      senderType: event.sender?.sender_type ?? "missing",
      messageType: event.message?.message_type ?? "missing",
      hasMessageId: Boolean(event.message?.message_id?.trim()),
      hasChatId: Boolean(event.message?.chat_id?.trim()),
      hasSenderId: Boolean(
        event.sender?.sender_id?.open_id?.trim()
        || event.sender?.sender_id?.user_id?.trim()
        || event.sender?.sender_id?.union_id?.trim()
      ),
      contentLength: typeof event.message?.content === "string" ? event.message.content.length : 0
    });
  }

  private isDuplicate(messageId: string): boolean {
    const now = this.options.now?.() ?? Date.now();
    const seenAt = this.seenMessages.get(messageId);
    return seenAt !== undefined && now - seenAt <= 10 * 60_000;
  }

  private remember(messageId: string): void {
    const now = this.options.now?.() ?? Date.now();
    for (const [key, seenAt] of this.seenMessages) {
      if (now - seenAt > 10 * 60_000 || this.seenMessages.size >= 2_048) {
        this.seenMessages.delete(key);
      }
    }
    this.seenMessages.set(messageId, now);
  }
}

export function normalizeFeishuInbound(
  event: FeishuMessageEvent,
  accountKey: string
): InboundMessage | null {
  const messageId = event.message.message_id.trim();
  const chatId = event.message.chat_id.trim();
  const senderId = event.sender.sender_id?.open_id?.trim()
    || event.sender.sender_id?.user_id?.trim()
    || event.sender.sender_id?.union_id?.trim()
    || "";
  const text = extractFeishuText(event.message.message_type, event.message.content);
  if (!messageId || !chatId || !senderId || !text) {
    return null;
  }
  const chatType = event.message.chat_type === "group" ? "group" : "c2c";
  return {
    messageId,
    accountKey,
    sessionKey: `${accountKey}::fs:${chatType}:${chatId}`,
    peerKey: `fs:${chatType}:${chatId}`,
    chatType,
    senderId,
    text,
    ...replyToMessageId(event.message),
    receivedAt: normalizeFeishuTime(event.message.create_time)
  };
}

function replyToMessageId(message: {
  parent_id?: string;
  root_id?: string;
}): { replyToMessageId: string } | Record<string, never> {
  const id = message.parent_id?.trim() || message.root_id?.trim();
  return id ? { replyToMessageId: id } : {};
}

function extractFeishuText(messageType: string, content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object") {
    return "";
  }
  if (messageType === "text") {
    const text = (parsed as Record<string, unknown>).text;
    return typeof text === "string" ? text.trim() : "";
  }
  if (messageType !== "post") {
    return "";
  }
  return collectPostText(parsed).join("\n").trim();
}

function collectPostText(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectPostText);
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  const ownText = typeof record.text === "string" ? [record.text] : [];
  const title = typeof record.title === "string" ? [record.title] : [];
  return [...title, ...ownText, ...Object.entries(record)
    .filter(([key]) => key !== "text" && key !== "title")
    .flatMap(([, nested]) => collectPostText(nested))];
}

function normalizeFeishuTime(value: string): string {
  const numeric = Number(value);
  const millis = Number.isFinite(numeric)
    ? (numeric < 10_000_000_000 ? numeric * 1_000 : numeric)
    : Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : new Date().toISOString();
}

function isBotSender(senderType: string): boolean {
  const normalized = senderType.toLowerCase();
  return normalized.includes("app") || normalized.includes("bot");
}
