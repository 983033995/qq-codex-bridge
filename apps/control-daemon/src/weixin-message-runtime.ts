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

export class WeixinMessageRuntime {
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
  }) {}

  async handle(input: WeixinInboundTextMessage): Promise<WeixinMessageRuntimeResult> {
    const account = parseChannelAccountId(input.accountId);
    if (account.channel !== "weixin") {
      throw new Error(`Weixin inbound account '${input.accountId}' is invalid`);
    }
    const accountId = createChannelAccountId("weixin", account.accountId);
    const spaceId = createConversationSpaceId(accountId, input.chatType, input.peerId);
    const existingSpace = await this.deps.spaces.get(spaceId);
    const space: ConversationSpace = existingSpace ?? {
      spaceId,
      channel: "weixin",
      accountId,
      providerConversationId: input.peerId,
      scope: input.chatType,
      displayName: input.peerId,
      status: "active",
      lastInboundAt: null,
      lastOutboundAt: null
    };
    const message: InboundEnvelope = {
      messageId: stableMessageId(input.accountId, input.providerMessageId),
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
        message: received.message,
        delivery: await this.deps.deliveries.findByKey(deliveryKey)
      };
    }

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
      createdAt,
      updatedAt: createdAt
    };
    await this.deps.deliveries.save(delivery);
    delivery = transitionDelivery(delivery, "sending", { at: this.deps.clock.now().toISOString() });
    await this.deps.deliveries.save(delivery);
    try {
      const providerMessageId = await this.deps.worker.deliver({
        deliveryKey,
        accountId: input.accountId,
        peerId: input.peerId,
        chatType: input.chatType,
        text,
        ...(outboundMedia.attachments.length > 0
          ? { attachments: outboundMedia.attachments }
          : {})
      });
      delivery = transitionDelivery(delivery, "delivered", {
        at: this.deps.clock.now().toISOString(),
        providerMessageId: providerMessageId ?? deliveryKey
      });
      await this.deps.deliveries.save(delivery);
      await this.deps.spaces.save({
        ...(await this.deps.spaces.get(spaceId) ?? space),
        lastOutboundAt: delivery.updatedAt
      });
      return { duplicate: false, message, delivery };
    } catch (error) {
      const errorCode = stableDeliveryError(error);
      delivery = transitionDelivery(delivery, isRetryable(error) ? "retry_wait" : "failed", {
        at: this.deps.clock.now().toISOString(),
        errorCode
      });
      await this.deps.deliveries.save(delivery);
      throw error;
    }
  }
}

function stableMessageId(accountId: string, providerMessageId: string): string {
  return `weixin-${createHash("sha256").update(accountId).update("\0").update(providerMessageId).digest("hex")}`;
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
