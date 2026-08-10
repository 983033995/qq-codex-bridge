import { z } from "zod";

export const WEIXIN_WORKER_PROTOCOL_VERSION = 1 as const;
export const WEIXIN_WORKER_VERSION = "0.2.0";
export const WEIXIN_WORKER_AUTH_ENV = "QQCB_WEIXIN_WORKER_AUTH_TOKEN";

const timestampSchema = z.string().datetime({ offset: true });
const versionSchema = z.string().trim().min(1).max(64);
const accountIdSchema = z.string().trim().min(1).max(128);

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
