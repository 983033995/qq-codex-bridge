import { z } from "zod";

export const WEIXIN_WORKER_PROTOCOL_VERSION = 2 as const;
export const WEIXIN_WORKER_VERSION = "0.2.0";
export const WEIXIN_WORKER_AUTH_ENV = "QQCB_WEIXIN_WORKER_AUTH_TOKEN";

const timestampSchema = z.string().datetime({ offset: true });
const versionSchema = z.string().trim().min(1).max(64);
const accountIdSchema = z.string().trim().min(1).max(128);
const identifierSchema = z.string().trim().min(1).max(512);
const inboundTextSchema = z.string().max(100_000);
const attachmentSchema = z.object({
  id: identifierSchema,
  kind: z.enum(["image", "audio", "video", "file"]),
  localPath: z.string().trim().min(1).max(1_024),
  mimeType: z.string().trim().min(1).max(256),
  size: z.number().int().nonnegative().max(25 * 1024 * 1024),
  name: z.string().trim().min(1).max(256).optional(),
  transcript: z.string().trim().min(1).max(100_000).optional()
}).strict();

export const weixinInboundTextMessageSchema = z.object({
  accountId: accountIdSchema,
  providerMessageId: identifierSchema,
  senderId: identifierSchema,
  peerId: identifierSchema,
  chatType: z.literal("c2c"),
  sequence: z.number().int().nonnegative(),
  receivedAt: timestampSchema,
  text: inboundTextSchema,
  attachments: z.array(attachmentSchema).max(16).default([])
}).strict().superRefine((message, context) => {
  if (!message.text.trim() && message.attachments.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["text"],
      message: "Inbound Weixin message requires text or attachments"
    });
  }
});

export const weixinTextDeliverySchema = z.object({
  deliveryKey: identifierSchema,
  accountId: accountIdSchema,
  peerId: identifierSchema,
  chatType: z.enum(["c2c", "group"]),
  text: z.string().max(100_000),
  attachments: z.array(attachmentSchema).max(16).optional()
}).strict().superRefine((delivery, context) => {
  if (!delivery.text.trim() && !(delivery.attachments?.length)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["text"],
      message: "Weixin delivery requires text or attachments"
    });
  }
});

export const weixinLoginStateSchema = z.object({
  accountId: accountIdSchema,
  status: z.enum([
    "logged_out",
    "requesting_qr",
    "awaiting_scan",
    "scanned",
    "awaiting_confirmation",
    "logged_in",
    "expired",
    "invalid"
  ]),
  message: z.string().trim().min(1).max(256),
  updatedAt: timestampSchema,
  qrCodeContent: z.string().min(1).max(8_192).optional(),
  expiresAt: timestampSchema.optional()
}).strict();

export const daemonToWorkerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("initialize"),
    protocolVersion: z.literal(WEIXIN_WORKER_PROTOCOL_VERSION),
    daemonVersion: versionSchema,
    heartbeatIntervalMs: z.number().int().min(10).max(60_000),
    accounts: z.array(accountIdSchema).max(32),
    login: z.object({
      stateFilePath: z.string().trim().min(1).max(1_024),
      baseUrl: z.string().url(),
      botType: z.string().trim().min(1).max(32),
      qrFetchTimeoutMs: z.number().int().positive().max(120_000),
      qrPollTimeoutMs: z.number().int().positive().max(120_000),
      qrTotalTimeoutMs: z.number().int().positive().max(30 * 60_000)
    }).strict(),
    message: z.object({
      stateFilePath: z.string().trim().min(1).max(1_024),
      longPollTimeoutMs: z.number().int().positive().max(120_000),
      apiTimeoutMs: z.number().int().positive().max(120_000),
      retryDelayMs: z.number().int().nonnegative().max(60_000)
    }).strict()
  }).strict(),
  z.object({
    type: z.literal("ping"),
    id: z.string().uuid(),
    sentAt: timestampSchema
  }).strict(),
  z.object({
    type: z.literal("shutdown"),
    reason: z.string().trim().min(1).max(256)
  }).strict(),
  z.object({
    type: z.literal("login.start"),
    requestId: z.string().uuid(),
    accountId: accountIdSchema,
    force: z.boolean()
  }).strict(),
  z.object({
    type: z.literal("login.status"),
    requestId: z.string().uuid(),
    accountId: accountIdSchema
  }).strict(),
  z.object({
    type: z.literal("login.logout"),
    requestId: z.string().uuid(),
    accountId: accountIdSchema
  }).strict(),
  z.object({
    type: z.literal("message.deliver"),
    requestId: z.string().uuid(),
    delivery: weixinTextDeliverySchema
  }).strict()
]);

export const workerToDaemonMessageSchema = z.union([
  z.object({
    type: z.literal("hello"),
    authToken: z.string().min(32).max(256),
    protocolVersion: z.number().int().positive(),
    workerVersion: versionSchema,
    pid: z.number().int().positive()
  }).strict(),
  z.object({
    type: z.literal("ready"),
    protocolVersion: z.literal(WEIXIN_WORKER_PROTOCOL_VERSION),
    workerVersion: versionSchema,
    startedAt: timestampSchema,
    accounts: z.array(z.string().trim().min(1).max(128)).max(32)
  }).strict(),
  z.object({
    type: z.literal("heartbeat"),
    sequence: z.number().int().nonnegative(),
    occurredAt: timestampSchema
  }).strict(),
  z.object({
    type: z.literal("pong"),
    id: z.string().uuid(),
    occurredAt: timestampSchema
  }).strict(),
  z.object({
    type: z.literal("stopped"),
    occurredAt: timestampSchema
  }).strict(),
  z.object({
    type: z.literal("login.state"),
    state: weixinLoginStateSchema
  }).strict(),
  z.object({
    type: z.literal("message.inbound"),
    message: weixinInboundTextMessageSchema
  }).strict(),
  z.object({
    type: z.literal("message.error"),
    accountId: accountIdSchema,
    error: z.object({
      code: z.string().trim().min(1).max(128),
      message: z.string().trim().min(1).max(256),
      retryable: z.boolean()
    }).strict()
  }).strict(),
  z.object({
    type: z.literal("command.result"),
    requestId: z.string().uuid(),
    ok: z.literal(true),
    state: weixinLoginStateSchema
  }).strict(),
  z.object({
    type: z.literal("command.result"),
    requestId: z.string().uuid(),
    ok: z.literal(false),
    error: z.object({
      code: z.string().trim().min(1).max(128),
      message: z.string().trim().min(1).max(256)
    }).strict()
  }).strict(),
  z.object({
    type: z.literal("delivery.result"),
    requestId: z.string().uuid(),
    ok: z.literal(true),
    providerMessageId: identifierSchema.nullable()
  }).strict(),
  z.object({
    type: z.literal("delivery.result"),
    requestId: z.string().uuid(),
    ok: z.literal(false),
    error: z.object({
      code: z.string().trim().min(1).max(128),
      message: z.string().trim().min(1).max(256),
      retryable: z.boolean()
    }).strict()
  }).strict()
]);

export type DaemonToWorkerMessage = z.infer<typeof daemonToWorkerMessageSchema>;
export type WorkerToDaemonMessage = z.infer<typeof workerToDaemonMessageSchema>;

export function parseDaemonToWorkerMessage(value: unknown): DaemonToWorkerMessage {
  return daemonToWorkerMessageSchema.parse(value);
}

export function parseWorkerToDaemonMessage(value: unknown): WorkerToDaemonMessage {
  return workerToDaemonMessageSchema.parse(value);
}
