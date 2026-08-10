import { z } from "zod";

const accountIdSchema = z.string().trim().min(1).max(128).regex(/^\S+$/);
const secretRefSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9/_-]*$/, "Secret references must be lowercase path-like names");

const weixinChannelSchema = z.object({
  channel: z.literal("weixin"),
  accountId: accountIdSchema,
  enabled: z.boolean()
}).strict();

const feishuChannelSchema = z.object({
  channel: z.literal("feishu"),
  accountId: accountIdSchema,
  enabled: z.boolean(),
  appId: z.string().trim().min(1),
  secretRef: secretRefSchema
}).strict();

const qqChannelSchema = z.object({
  channel: z.literal("qq"),
  accountId: accountIdSchema,
  enabled: z.boolean(),
  appId: z.string().trim().min(1),
  secretRef: secretRefSchema
}).strict();

export const channelConfigSchema = z.discriminatedUnion("channel", [
  weixinChannelSchema,
  feishuChannelSchema,
  qqChannelSchema
]);

export const vnextConfigSchema = z.object({
  version: z.literal(1),
  runtime: z.object({
    listenHost: z.string().refine(isLoopbackHost, "Management API must bind to a loopback host"),
    listenPort: z.number().int().min(1).max(65535),
    maxParallelThreads: z.number().int().min(1).max(5)
  }).strict(),
  codex: z.object({
    transport: z.literal("app-server"),
    recoveryTransport: z.literal("cdp")
  }).strict(),
  router: z.object({
    mode: z.enum(["off", "assist", "auto"]),
    adapter: z.literal("openai-compatible"),
    baseUrl: z.string().url().nullable(),
    model: z.string().trim().min(1).nullable(),
    secretRef: secretRefSchema.nullable(),
    highConfidenceThreshold: z.number().min(0.9).max(1),
    clarifyThreshold: z.number().min(0.5).max(0.89)
  }).strict(),
  channels: z.array(channelConfigSchema),
  push: z.object({
    enabled: z.boolean(),
    outboxRoot: z.string().trim().min(1),
    maxRequestsPerMinute: z.number().int().positive()
  }).strict(),
  queues: z.object({
    spaceLimit: z.number().int().positive(),
    threadLimit: z.number().int().positive(),
    progressDelayMs: z.number().int().nonnegative()
  }).strict()
}).strict().superRefine((config, context) => {
  if (config.router.clarifyThreshold >= config.router.highConfidenceThreshold) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["router", "clarifyThreshold"],
      message: "Clarify threshold must be lower than the high-confidence threshold"
    });
  }

  if (config.router.mode !== "off") {
    for (const field of ["baseUrl", "model", "secretRef"] as const) {
      if (!config.router[field]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["router", field],
          message: `${field} is required when Router mode is enabled`
        });
      }
    }
  }

  if (config.router.baseUrl && !isSafeRouterUrl(config.router.baseUrl)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["router", "baseUrl"],
      message: "Router URL must use HTTPS, except HTTP is allowed on loopback hosts"
    });
  }

  const seenAccounts = new Set<string>();
  config.channels.forEach((channel, index) => {
    const key = `${channel.channel}:${channel.accountId}`;
    if (seenAccounts.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["channels", index, "accountId"],
        message: `Duplicate channel account '${key}'`
      });
    }
    seenAccounts.add(key);
  });
});

export type VNextConfig = z.infer<typeof vnextConfigSchema>;
export type ChannelConfig = z.infer<typeof channelConfigSchema>;

export function createDefaultConfig(): VNextConfig {
  return vnextConfigSchema.parse({
    version: 1,
    runtime: {
      listenHost: "127.0.0.1",
      listenPort: 3100,
      maxParallelThreads: 3
    },
    codex: {
      transport: "app-server",
      recoveryTransport: "cdp"
    },
    router: {
      mode: "off",
      adapter: "openai-compatible",
      baseUrl: null,
      model: null,
      secretRef: null,
      highConfidenceThreshold: 0.9,
      clarifyThreshold: 0.65
    },
    channels: [],
    push: {
      enabled: false,
      outboxRoot: "media/push-outbox",
      maxRequestsPerMinute: 60
    },
    queues: {
      spaceLimit: 20,
      threadLimit: 10,
      progressDelayMs: 2000
    }
  });
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") {
    return true;
  }
  const parts = normalized.split(".").map(Number);
  return parts.length === 4
    && parts[0] === 127
    && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
}

function isSafeRouterUrl(value: string): boolean {
  const url = new URL(value);
  if (url.username || url.password) {
    return false;
  }
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname));
}
