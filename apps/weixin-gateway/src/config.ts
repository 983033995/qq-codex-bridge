import { z } from "zod";

const weixinGatewayAccountConfigSchema = z.object({
  accountId: z.string().min(1),
  bridgeWebhookPath: z.string().startsWith("/"),
  baseUrl: z.string().url(),
  token: z.string().min(1).nullable(),
  messageStorePath: z.string().min(1)
});

export const weixinGatewayConfigSchema = z.object({
  listenHost: z.string().min(1),
  listenPort: z.number().int().positive(),
  bridgeBaseUrl: z.string().url(),
  bridgeWebhookPath: z.string().startsWith("/"),
  expectedBearerToken: z.string().min(1).nullable(),
  messageStorePath: z.string().min(1),
  recentMessageLimit: z.number().int().positive(),
  enabled: z.boolean(),
  accountId: z.string().min(1),
  baseUrl: z.string().url(),
  token: z.string().min(1).nullable(),
  longPollTimeoutMs: z.number().int().positive(),
  apiTimeoutMs: z.number().int().positive(),
  stateFilePath: z.string().min(1),
  loginBaseUrl: z.string().url(),
  loginBotType: z.string().min(1),
  qrFetchTimeoutMs: z.number().int().positive(),
  qrPollTimeoutMs: z.number().int().positive(),
  qrTotalTimeoutMs: z.number().int().positive(),
  stateWatchIntervalMs: z.number().int().positive(),
  accounts: z.array(weixinGatewayAccountConfigSchema).min(1)
});

export type WeixinGatewayConfig = z.infer<typeof weixinGatewayConfigSchema>;

export function loadWeixinGatewayConfigFromEnv(env: NodeJS.ProcessEnv): WeixinGatewayConfig {
  const fallbackAccount = {
    accountId: env.WEIXIN_ACCOUNT_ID ?? "default",
    bridgeWebhookPath: env.WEIXIN_GATEWAY_BRIDGE_WEBHOOK_PATH
      ?? env.WEIXIN_WEBHOOK_PATH
      ?? "/webhooks/weixin",
    baseUrl: env.WEIXIN_BASE_URL ?? "https://ilinkai.weixin.qq.com",
    token: env.WEIXIN_TOKEN ?? null,
    messageStorePath: env.WEIXIN_GATEWAY_MESSAGE_STORE_PATH
      ?? "runtime/weixin-gateway-messages.ndjson"
  };

  return weixinGatewayConfigSchema.parse({
    listenHost: env.WEIXIN_GATEWAY_LISTEN_HOST ?? "127.0.0.1",
    listenPort: Number(env.WEIXIN_GATEWAY_LISTEN_PORT ?? "3200"),
    bridgeBaseUrl: env.WEIXIN_GATEWAY_BRIDGE_BASE_URL
      ?? `http://${env.QQ_CODEX_LISTEN_HOST ?? "127.0.0.1"}:${env.QQ_CODEX_LISTEN_PORT ?? "3100"}`,
    bridgeWebhookPath: env.WEIXIN_GATEWAY_BRIDGE_WEBHOOK_PATH
      ?? env.WEIXIN_WEBHOOK_PATH
      ?? "/webhooks/weixin",
    expectedBearerToken: env.WEIXIN_GATEWAY_EXPECTED_TOKEN ?? env.WEIXIN_EGRESS_TOKEN ?? null,
    messageStorePath: env.WEIXIN_GATEWAY_MESSAGE_STORE_PATH
      ?? "runtime/weixin-gateway-messages.ndjson",
    recentMessageLimit: Number(env.WEIXIN_GATEWAY_RECENT_MESSAGE_LIMIT ?? "100"),
    enabled: env.WEIXIN_ENABLED !== "false",
    accountId: env.WEIXIN_ACCOUNT_ID ?? "default",
    baseUrl: env.WEIXIN_BASE_URL ?? "https://ilinkai.weixin.qq.com",
    token: env.WEIXIN_TOKEN ?? null,
    longPollTimeoutMs: Number(env.WEIXIN_LONG_POLL_TIMEOUT_MS ?? "35000"),
    apiTimeoutMs: Number(env.WEIXIN_API_TIMEOUT_MS ?? "15000"),
    stateFilePath: env.WEIXIN_GATEWAY_STATE_FILE_PATH ?? "runtime/weixin-gateway-state.json",
    loginBaseUrl: env.WEIXIN_LOGIN_BASE_URL ?? "https://ilinkai.weixin.qq.com",
    loginBotType: env.WEIXIN_BOT_TYPE ?? "3",
    qrFetchTimeoutMs: Number(env.WEIXIN_QR_FETCH_TIMEOUT_MS ?? "10000"),
    qrPollTimeoutMs: Number(env.WEIXIN_QR_POLL_TIMEOUT_MS ?? "35000"),
    qrTotalTimeoutMs: Number(env.WEIXIN_QR_TOTAL_TIMEOUT_MS ?? String(8 * 60 * 1000)),
    stateWatchIntervalMs: Number(env.WEIXIN_GATEWAY_STATE_WATCH_INTERVAL_MS ?? "1000"),
    accounts: resolveGatewayAccounts(env, fallbackAccount)
  });
}

function resolveGatewayAccounts(
  env: NodeJS.ProcessEnv,
  fallback: {
    accountId: string;
    bridgeWebhookPath: string;
    baseUrl: string;
    token: string | null;
    messageStorePath: string;
  }
) {
  const jsonAccounts = parseJsonArray(env.WEIXIN_GATEWAY_ACCOUNTS_JSON ?? env.WEIXIN_ACCOUNTS_JSON);
  if (jsonAccounts) {
    return jsonAccounts.map((item, index) => {
      const record = asRecord(item);
      const accountId = stringValue(record.accountId ?? record.id, `account${index + 1}`);
      return {
        accountId,
        bridgeWebhookPath: stringValue(
          record.bridgeWebhookPath ?? record.webhookPath,
          `/webhooks/weixin/${accountId}`
        ),
        baseUrl: stringValue(record.baseUrl, fallback.baseUrl),
        token: nullableString(record.token ?? record.weixinToken),
        messageStorePath: stringValue(
          record.messageStorePath,
          `runtime/weixin-gateway-messages-${safePathSegment(accountId)}.ndjson`
        )
      };
    });
  }

  const accountIds = splitList(env.WEIXIN_GATEWAY_ACCOUNT_IDS ?? env.WEIXIN_ACCOUNT_IDS);
  if (accountIds.length > 0) {
    return accountIds.map((accountId, index) => {
      const suffix = envNameSuffix(accountId);
      return {
        accountId,
        bridgeWebhookPath: env[`WEIXIN_GATEWAY_${suffix}_BRIDGE_WEBHOOK_PATH`]
          ?? env[`WEIXIN_${suffix}_WEBHOOK_PATH`]
          ?? `/webhooks/weixin/${accountId}`,
        baseUrl: env[`WEIXIN_${suffix}_BASE_URL`] ?? fallback.baseUrl,
        token: env[`WEIXIN_${suffix}_TOKEN`] ?? (index === 0 ? fallback.token : null),
        messageStorePath: env[`WEIXIN_GATEWAY_${suffix}_MESSAGE_STORE_PATH`]
          ?? `runtime/weixin-gateway-messages-${safePathSegment(accountId)}.ndjson`
      };
    });
  }

  return [fallback];
}

function parseJsonArray(value: string | undefined): unknown[] | null {
  if (!value?.trim()) {
    return null;
  }
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function nullableString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function envNameSuffix(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
}
