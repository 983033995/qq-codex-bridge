import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { z } from "zod";
import type { WeixinGatewayConfig } from "./config.js";
import {
  WeixinGatewayMessageStore,
  type WeixinGatewayOutboundMessage
} from "./message-store.js";
import {
  MediaArtifactKind,
  type MediaArtifact
} from "../../../packages/domain/src/message.js";

const inboundTextPayloadSchema = z.object({
  accountKey: z.string().min(1).optional(),
  chatType: z.enum(["c2c", "group"]).optional(),
  senderId: z.string().min(1),
  peerId: z.string().min(1).optional(),
  messageId: z.string().min(1),
  text: z.string().min(1),
  receivedAt: z.string().optional()
});

const mediaArtifactSchema = z.object({
  kind: z.nativeEnum(MediaArtifactKind),
  sourceUrl: z.string().min(1),
  localPath: z.string().min(1),
  mimeType: z.string().min(1),
  fileSize: z.number().nonnegative(),
  originalName: z.string().min(1),
  transcript: z.string().nullable().optional(),
  transcriptSource: z.enum(["stt", "asr", "fallback"]).nullable().optional(),
  extractedText: z.string().nullable().optional()
});

const outboundMessagePayloadSchema = z.object({
  peerId: z.string().min(1),
  chatType: z.enum(["c2c", "group"]),
  content: z.string().min(1).optional(),
  mediaArtifacts: z.array(mediaArtifactSchema).min(1).optional(),
  replyToMessageId: z.string().min(1).optional()
}).superRefine((payload, ctx) => {
  if (!payload.content && !(payload.mediaArtifacts?.length)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "content or mediaArtifacts is required",
      path: ["content"]
    });
  }
});

type WeixinGatewayDeps = {
  config: WeixinGatewayConfig;
  messageStore?: Pick<WeixinGatewayMessageStore, "append" | "listRecent">;
  fetchFn?: typeof fetch;
  outboundSender?: {
    sendTextMessage(target: {
      peerId: string;
      chatType: "c2c" | "group";
      text: string;
      replyToMessageId?: string;
    }): Promise<void>;
    sendMessage?(target: {
      peerId: string;
      chatType: "c2c" | "group";
      content?: string;
      mediaArtifacts?: MediaArtifact[];
      replyToMessageId?: string;
    }): Promise<void>;
  };
};

export function createWeixinGatewayServer(deps: WeixinGatewayDeps): Server {
  const messageStore =
    deps.messageStore
    ?? new WeixinGatewayMessageStore(
      deps.config.messageStorePath,
      deps.config.recentMessageLimit
    );
  const fetchFn = deps.fetchFn ?? fetch;

  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        writeJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && request.url === "/messages") {
        writeJson(response, 200, {
          items: messageStore.listRecent()
        });
        return;
      }

      if (request.method !== "POST") {
        writePlain(response, 405, "method not allowed");
        return;
      }

      if (request.url === "/inbound/text") {
        const payload = inboundTextPayloadSchema.parse(await readJsonBody(request));
        const bridgePayload = {
          accountKey: payload.accountKey,
          chatType: payload.chatType ?? "c2c",
          senderId: payload.senderId,
          peerId: payload.peerId ?? payload.senderId,
          messageId: payload.messageId,
          text: payload.text,
          receivedAt: payload.receivedAt
        };

        const bridgeResponse = await fetchFn(
          `${deps.config.bridgeBaseUrl}${deps.config.bridgeWebhookPath}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify(bridgePayload)
          }
        );

        if (!bridgeResponse.ok) {
          const bridgeText = await bridgeResponse.text().catch(() => "");
          throw new Error(
            `bridge webhook failed: ${bridgeResponse.status}${bridgeText ? ` ${bridgeText}` : ""}`
          );
        }

        writeJson(response, 202, {
          accepted: true
        });
        return;
      }

      if (request.url === "/messages") {
        assertBearerToken(request, deps.config.expectedBearerToken);
        const payload = outboundMessagePayloadSchema.parse(await readJsonBody(request));
        const duplicate = findRecentDuplicateOutbound(messageStore.listRecent(), payload);
        if (duplicate) {
          writeJson(response, 200, { id: duplicate.id, deduped: true });
          return;
        }

        const message: WeixinGatewayOutboundMessage = {
          id: randomUUID(),
          peerId: payload.peerId,
          chatType: payload.chatType,
          ...(payload.content ? { content: payload.content } : {}),
          ...(payload.mediaArtifacts?.length ? { mediaArtifacts: payload.mediaArtifacts } : {}),
          ...(payload.replyToMessageId ? { replyToMessageId: payload.replyToMessageId } : {}),
          createdAt: new Date().toISOString()
        };

        messageStore.append(message);
        if (deps.outboundSender) {
          if (payload.mediaArtifacts?.length && deps.outboundSender.sendMessage) {
            await deps.outboundSender.sendMessage({
              peerId: payload.peerId,
              chatType: payload.chatType,
              ...(payload.content ? { content: payload.content } : {}),
              mediaArtifacts: payload.mediaArtifacts,
              ...(payload.replyToMessageId ? { replyToMessageId: payload.replyToMessageId } : {})
            });
          } else {
            await deps.outboundSender.sendTextMessage({
              peerId: payload.peerId,
              chatType: payload.chatType,
              text: payload.content ?? "",
              ...(payload.replyToMessageId ? { replyToMessageId: payload.replyToMessageId } : {})
            });
          }
        }
        console.log("[weixin-gateway] outbound message", {
          id: message.id,
          chatType: message.chatType,
          peerId: message.peerId,
          preview: clipPreview(message.content ?? ""),
          mediaCount: message.mediaArtifacts?.length ?? 0
        });

        writeJson(response, 200, { id: message.id });
        return;
      }

      writePlain(response, 404, "not found");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = error instanceof z.ZodError ? 400 : 500;
      writeJson(response, statusCode, {
        error: message
      });
    }
  });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function assertBearerToken(request: IncomingMessage, expectedToken: string | null): void {
  if (!expectedToken) {
    return;
  }

  const authHeader = request.headers.authorization;
  if (authHeader !== `Bearer ${expectedToken}`) {
    throw new Error("unauthorized");
  }
}

function clipPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function findRecentDuplicateOutbound(
  recentMessages: WeixinGatewayOutboundMessage[],
  payload: z.infer<typeof outboundMessagePayloadSchema>
): WeixinGatewayOutboundMessage | null {
  const fingerprint = buildOutboundFingerprint(payload);
  if (!fingerprint) {
    return null;
  }

  const now = Date.now();
  for (const message of recentMessages) {
    const createdAtMs = Date.parse(message.createdAt);
    if (!Number.isFinite(createdAtMs) || now - createdAtMs > 120_000) {
      continue;
    }

    if (buildOutboundFingerprint(message) === fingerprint) {
      return message;
    }
  }

  return null;
}

function buildOutboundFingerprint(message: {
  peerId: string;
  chatType: "c2c" | "group";
  content?: string;
  mediaArtifacts?: MediaArtifact[];
  replyToMessageId?: string;
}): string {
  const peerId = String(message.peerId ?? "").trim();
  const chatType = String(message.chatType ?? "").trim();
  const replyToMessageId = String(message.replyToMessageId ?? "").trim();
  const content = String(message.content ?? "").replace(/\s+/g, " ").trim();
  const mediaFingerprint = (message.mediaArtifacts ?? [])
    .map((artifact) =>
      [
        artifact.kind,
        artifact.localPath || "",
        artifact.sourceUrl || "",
        artifact.originalName || ""
      ].join("::")
    )
    .join("|");

  return [peerId, chatType, replyToMessageId, content, mediaFingerprint].join("||");
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function writePlain(
  response: ServerResponse,
  statusCode: number,
  payload: string
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(payload);
}
