import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BindConversationSpace,
  ReceiveInboundMessage,
  StartConversationTurn
} from "../../../packages/application/src/index.js";
import { WeixinDeliveryError, type WeixinInboundTextMessage } from "../../../packages/channel-weixin/src/index.js";
import {
  createChannelAccountId,
  createConversationSpaceId,
  parseChannelAccountId,
  transitionDelivery,
  type ConversationSpace,
  type Delivery,
  type Attachment,
  type InboundEnvelope,
  type MessageContent,
  type StableErrorCode
} from "../../../packages/domain/src/vnext/index.js";
import type {
  Clock,
  ConversationSpaceRepository,
  DeliveryRepository,
  IdGenerator
} from "../../../packages/ports/src/vnext/index.js";

export type WeixinMessageRuntimeResult = {
  duplicate: boolean;
  message: InboundEnvelope;
  delivery: Delivery | null;
};

export type ChannelInboundTextMessage = {
  accountId: string;
  providerMessageId: string;
  peerId: string;
  chatType: "c2c" | "group";
  senderId: string;
  text: string;
  attachments: Attachment[];
  sequence: number;
  receivedAt: string;
};

export class WeixinMessageRuntime {
  private readonly channel: "weixin" | "feishu";
  private readonly maxDeliveryAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly recoveryLimit: number;
  private readonly activeRecoveries = new Set<string>();
  private recovery: Promise<void> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryTimerDueAt: number | null = null;
  private started = false;

  constructor(private readonly deps: {
    spaces: ConversationSpaceRepository;
    deliveries: DeliveryRepository;
    receive: Pick<ReceiveInboundMessage, "execute">;
    bind: Pick<BindConversationSpace, "execute">;
    startTurn: Pick<StartConversationTurn, "execute">;
    worker: { deliver(input: {
      deliveryKey: string;
      accountId: string;
      peerId: string;
      chatType: "c2c" | "group";
      text: string;
      attachments?: Attachment[];
    }): Promise<string | null> };
    ids: IdGenerator;
    clock: Clock;
    onProcessingError?(error: Error, message: InboundEnvelope): void;
    retry?: {
      maxAttempts?: number;
      baseDelayMs?: number;
      maxDelayMs?: number;
      recoveryLimit?: number;
    };
    channel?: "weixin" | "feishu";
  }) {
    this.channel = deps.channel ?? "weixin";
    this.maxDeliveryAttempts = positiveInteger(deps.retry?.maxAttempts ?? 3, "retry.maxAttempts");
    this.retryBaseDelayMs = positiveInteger(deps.retry?.baseDelayMs ?? 1_000, "retry.baseDelayMs");
    this.retryMaxDelayMs = positiveInteger(deps.retry?.maxDelayMs ?? 60_000, "retry.maxDelayMs");
    this.recoveryLimit = positiveInteger(deps.retry?.recoveryLimit ?? 100, "retry.recoveryLimit");
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.recoverDeliveries();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryTimerDueAt = null;
    await this.recovery;
  }

  recoverDeliveries(): Promise<void> {
    if (this.recovery) return this.recovery;
    this.recovery = this.scanRecoverable().finally(() => {
      this.recovery = null;
    });
    return this.recovery;
  }

  async handle(input: WeixinInboundTextMessage | ChannelInboundTextMessage): Promise<WeixinMessageRuntimeResult> {
    const received = await this.persistInbound(input);
    if (received.duplicate) return received.result;
    return this.processInbound(received.space, received.message);
  }

  async accept(input: WeixinInboundTextMessage | ChannelInboundTextMessage): Promise<void> {
    const received = await this.persistInbound(input);
    if (received.duplicate) return;
    void this.processInbound(received.space, received.message).catch((error) => {
      this.deps.onProcessingError?.(normalizeError(error), received.message);
    });
  }

  private async persistInbound(input: WeixinInboundTextMessage | ChannelInboundTextMessage): Promise<{
    duplicate: boolean;
    space: ConversationSpace;
    message: InboundEnvelope;
    result: WeixinMessageRuntimeResult;
  }> {
    const account = parseChannelAccountId(input.accountId);
    if (account.channel !== this.channel) {
      throw new Error(`${this.channel} inbound account '${input.accountId}' is invalid`);
    }
    const accountId = createChannelAccountId(this.channel, account.accountId);
    const spaceId = createConversationSpaceId(accountId, input.chatType, input.peerId);
    const existingSpace = await this.deps.spaces.get(spaceId);
    const space: ConversationSpace = existingSpace ?? {
      spaceId,
      channel: this.channel,
      accountId,
      providerConversationId: input.peerId,
      scope: input.chatType,
      displayName: input.peerId,
      status: "active",
      lastInboundAt: null,
      lastOutboundAt: null
    };
    const message: InboundEnvelope = {
      messageId: stableMessageId(this.channel, input.accountId, input.providerMessageId),
      providerMessageId: input.providerMessageId,
      spaceId,
      senderId: input.senderId,
      receivedSequence: input.sequence,
      receivedAt: input.receivedAt,
      content: { text: input.text, mentions: [], attachments: input.attachments }
    };
    const received = await this.deps.receive.execute({ space, message });
    const deliveryKey = `${received.message.messageId}:assistant-final`;
    if (!received.accepted) {
      return {
        duplicate: true,
        space,
        message: received.message,
        result: {
          duplicate: true,
          message: received.message,
          delivery: await this.deps.deliveries.findByKey(deliveryKey)
        }
      };
    }
    return {
      duplicate: false,
      space,
      message,
      result: { duplicate: false, message, delivery: null }
    };
  }

  private async processInbound(
    space: ConversationSpace,
    message: InboundEnvelope
  ): Promise<WeixinMessageRuntimeResult> {
    const { spaceId } = space;
    const deliveryKey = `${message.messageId}:assistant-final`;
    await this.deps.bind.execute({ spaceId });
    const turn = await this.deps.startTurn.execute(message);
    const outboundMedia = await resolveOutboundAttachments(turn.result.mediaReferences);
    const text = [
      turn.result.finalText.trim(),
      outboundMedia.rejected > 0
        ? `[有 ${outboundMedia.rejected} 个媒体附件未发送：仅支持本机 25 MiB 以内的有效文件]`
        : ""
    ].filter(Boolean).join("\n");
    if (!text && outboundMedia.attachments.length === 0) {
      throw new Error("Codex turn completed without a deliverable reply");
    }

    const createdAt = this.deps.clock.now().toISOString();
    let delivery: Delivery = {
      deliveryId: this.deps.ids.next(),
      deliveryKey,
      spaceId,
      status: "pending",
      providerMessageId: null,
      attempts: 0,
      errorCode: null,
      nextAttemptAt: null,
      createdAt,
      updatedAt: createdAt
    };
    const content = { text, mentions: [], attachments: outboundMedia.attachments };
    await this.deps.deliveries.save(delivery, content);
    delivery = await this.attemptDelivery(delivery, content, space);
    return { duplicate: false, message, delivery };
  }

  private async scanRecoverable(): Promise<void> {
    const deliveries = await this.deps.deliveries.listRecoverable({ limit: this.recoveryLimit });
    const now = this.deps.clock.now().getTime();
    let nextDelayMs: number | null = null;
    for (const recovery of deliveries) {
      const { delivery, content } = recovery;
      if (this.activeRecoveries.has(delivery.deliveryId)) continue;
      if (delivery.status === "retry_wait" && delivery.nextAttemptAt) {
        const delayMs = Date.parse(delivery.nextAttemptAt) - now;
        if (delayMs > 0) {
          nextDelayMs = nextDelayMs === null ? delayMs : Math.min(nextDelayMs, delayMs);
          continue;
        }
      }
      this.activeRecoveries.add(delivery.deliveryId);
      try {
        if (delivery.attempts >= this.maxDeliveryAttempts) {
          await this.failRecovery(delivery);
          continue;
        }
        const space = await this.deps.spaces.get(delivery.spaceId);
        if (!space) {
          await this.failRecovery(delivery);
          continue;
        }
        if (space.channel !== this.channel) continue;
        await this.attemptDelivery(delivery, content, space);
      } catch {
        // attemptDelivery persists a retry_wait or terminal failed state.
      } finally {
        this.activeRecoveries.delete(delivery.deliveryId);
      }
    }
    if (nextDelayMs !== null) this.scheduleRecovery(nextDelayMs);
  }

  private async attemptDelivery(
    current: Delivery,
    content: MessageContent,
    space: ConversationSpace
  ): Promise<Delivery> {
    let delivery = current;
    if (delivery.status !== "sending") {
      if (delivery.attempts >= this.maxDeliveryAttempts) {
        await this.failRecovery(delivery);
        throw new Error(`Delivery '${delivery.deliveryKey}' exhausted its retry limit`);
      }
      delivery = transitionDelivery(delivery, "sending", { at: this.deps.clock.now().toISOString() });
      await this.deps.deliveries.save(delivery);
    }
    try {
      const providerMessageId = await this.deps.worker.deliver({
        deliveryKey: delivery.deliveryKey,
        accountId: space.accountId,
        peerId: space.providerConversationId,
        chatType: space.scope,
        text: content.text,
        ...(content.attachments.length > 0
          ? { attachments: content.attachments }
          : {})
      });
      delivery = transitionDelivery(delivery, "delivered", {
        at: this.deps.clock.now().toISOString(),
        providerMessageId: providerMessageId ?? delivery.deliveryKey
      });
      await this.deps.deliveries.save(delivery);
      await this.deps.spaces.save({
        ...(await this.deps.spaces.get(delivery.spaceId) ?? space),
        lastOutboundAt: delivery.updatedAt
      });
      return delivery;
    } catch (error) {
      const errorCode = stableDeliveryError(error);
      const retryable = isRetryable(error) && delivery.attempts < this.maxDeliveryAttempts;
      const at = this.deps.clock.now();
      delivery = transitionDelivery(delivery, retryable ? "retry_wait" : "failed", {
        at: at.toISOString(),
        errorCode,
        ...(retryable ? { nextAttemptAt: new Date(at.getTime() + this.retryDelay(delivery.attempts)).toISOString() } : {})
      });
      await this.deps.deliveries.save(delivery);
      if (retryable) this.scheduleRecovery(this.retryDelay(delivery.attempts));
      throw error;
    }
  }

  private async failRecovery(delivery: Delivery): Promise<void> {
    if (delivery.status === "sending") {
      delivery = transitionDelivery(delivery, "failed", {
        at: this.deps.clock.now().toISOString(),
        errorCode: delivery.errorCode ?? "CHANNEL_DELIVERY_FAILED"
      });
    } else if (delivery.status === "retry_wait") {
      delivery = transitionDelivery(delivery, "failed", {
        at: this.deps.clock.now().toISOString(),
        errorCode: delivery.errorCode ?? "CHANNEL_DELIVERY_FAILED"
      });
    }
    await this.deps.deliveries.save(delivery);
  }

  private retryDelay(attempts: number): number {
    return Math.min(this.retryMaxDelayMs, this.retryBaseDelayMs * 2 ** Math.max(0, attempts - 1));
  }

  private scheduleRecovery(delayMs: number): void {
    if (!this.started) return;
    const boundedDelayMs = Math.max(0, Math.min(delayMs, this.retryMaxDelayMs));
    const dueAt = Date.now() + boundedDelayMs;
    if (this.retryTimer && this.retryTimerDueAt !== null && this.retryTimerDueAt <= dueAt) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimerDueAt = dueAt;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryTimerDueAt = null;
      void this.recoverDeliveries().catch(() => this.scheduleRecovery(this.retryBaseDelayMs));
    }, boundedDelayMs);
    this.retryTimer.unref();
  }
}

function stableMessageId(channel: "weixin" | "feishu", accountId: string, providerMessageId: string): string {
  return `${channel}-${createHash("sha256").update(accountId).update("\0").update(providerMessageId).digest("hex")}`;
}

function stableDeliveryError(error: unknown): StableErrorCode {
  return error instanceof WeixinDeliveryError
    && (error.code === "WEIXIN_NOT_LOGGED_IN" || error.code === "WEIXIN_AUTH_INVALID")
    ? "CHANNEL_AUTH_REQUIRED"
    : "CHANNEL_DELIVERY_FAILED";
}

function isRetryable(error: unknown): boolean {
  return error instanceof WeixinDeliveryError ? error.retryable : true;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

async function resolveOutboundAttachments(
  references: string[]
): Promise<{ attachments: Attachment[]; rejected: number }> {
  const attachments: Attachment[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const reference of references) {
    if (attachments.length >= 16) {
      rejected += 1;
      continue;
    }
    try {
      const candidate = localMediaPath(reference);
      if (!candidate) throw new Error("unsupported media reference");
      const resolved = await realpath(candidate);
      if (seen.has(resolved)) continue;
      const metadata = await stat(resolved);
      if (!metadata.isFile() || metadata.size > 25 * 1024 * 1024) {
        throw new Error("media file is invalid or too large");
      }
      seen.add(resolved);
      const name = path.basename(resolved);
      const media = inferMediaType(name);
      attachments.push({
        id: `codex-media-${createHash("sha256")
          .update(resolved)
          .update("\0")
          .update(String(metadata.size))
          .update("\0")
          .update(String(metadata.mtimeMs))
          .digest("hex")}`,
        kind: media.kind,
        localPath: resolved,
        mimeType: media.mimeType,
        size: metadata.size,
        name
      });
    } catch {
      rejected += 1;
    }
  }
  return { attachments, rejected };
}

function localMediaPath(reference: string): string | null {
  const normalized = reference.trim();
  if (path.isAbsolute(normalized)) return normalized;
  if (!normalized.startsWith("file://")) return null;
  try {
    return fileURLToPath(normalized);
  } catch {
    return null;
  }
}

function inferMediaType(name: string): Pick<Attachment, "kind" | "mimeType"> {
  switch (path.extname(name).toLowerCase()) {
    case ".png": return { kind: "image", mimeType: "image/png" };
    case ".jpg":
    case ".jpeg": return { kind: "image", mimeType: "image/jpeg" };
    case ".gif": return { kind: "image", mimeType: "image/gif" };
    case ".webp": return { kind: "image", mimeType: "image/webp" };
    case ".mp3": return { kind: "audio", mimeType: "audio/mpeg" };
    case ".wav": return { kind: "audio", mimeType: "audio/wav" };
    case ".amr": return { kind: "audio", mimeType: "audio/amr" };
    case ".m4a": return { kind: "audio", mimeType: "audio/mp4" };
    case ".mp4": return { kind: "video", mimeType: "video/mp4" };
    case ".txt": return { kind: "file", mimeType: "text/plain" };
    case ".pdf": return { kind: "file", mimeType: "application/pdf" };
    default: return { kind: "file", mimeType: "application/octet-stream" };
  }
}
