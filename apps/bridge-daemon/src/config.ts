import { z } from "zod";

const qqBotConfigSchema = z.object({
  accountId: z.string().min(1),
  appId: z.string().min(1),
  clientSecret: z.string().min(1),
  markdownSupport: z.boolean(),
  stt: z
    .union([
      z.object({
        provider: z.literal("local-whisper-cpp"),
        binaryPath: z.string().min(1),
        modelPath: z.string().min(1),
        language: z.string().min(1).optional()
      }),
      z.object({
        provider: z.literal("openai-compatible"),
        baseUrl: z.string().url(),
        apiKey: z.string().min(1),
        model: z.string().min(1)
      }),
      z.object({
        provider: z.literal("volcengine-flash"),
        endpoint: z.string().url(),
        appId: z.string().min(1),
        accessKey: z.string().min(1),
        resourceId: z.string().min(1),
        model: z.string().min(1)
      })
    ])
    .nullable()
});

const weixinConfigSchema = z.object({
  enabled: z.boolean(),
  accountId: z.string().min(1),
  webhookPath: z.string().startsWith("/"),
  egressBaseUrl: z.string().url().nullable(),
  egressToken: z.string().min(1).nullable()
});

export const appConfigSchema = z.object({
  databasePath: z.string().min(1),
  runtime: z.object({
    listenHost: z.string().min(1),
    listenPort: z.number().int().positive(),
    webhookPath: z.string().startsWith("/")
  }),
  qqBot: qqBotConfigSchema,
  qqBots: z.array(qqBotConfigSchema).min(1),
  weixin: weixinConfigSchema,
  weixinAccounts: z.array(weixinConfigSchema),
  codexDesktop: z.object({
    appName: z.string().min(1),
    remoteDebuggingPort: z.number().int().positive()
  }),
  conversationProvider: z.enum(["codex-desktop", "chatgpt-desktop"])
});

export type AppConfig = z.infer<typeof appConfigSchema>;

export function loadConfigFromEnv(env: NodeJS.ProcessEnv): AppConfig {
  const fallbackQqBot = {
    accountId: env.QQBOT_ACCOUNT_ID ?? "default",
    appId: env.QQBOT_APP_ID,
    clientSecret: env.QQBOT_CLIENT_SECRET,
    markdownSupport: env.QQBOT_MARKDOWN_SUPPORT === "true",
    stt: resolveSttConfig(env)
  };
  const fallbackWeixin = {
    enabled: env.WEIXIN_ENABLED === "true",
    accountId: env.WEIXIN_ACCOUNT_ID ?? "default",
    webhookPath: env.WEIXIN_WEBHOOK_PATH ?? "/webhooks/weixin",
    egressBaseUrl: env.WEIXIN_EGRESS_BASE_URL ?? null,
    egressToken: env.WEIXIN_EGRESS_TOKEN ?? null
  };

  return appConfigSchema.parse({
    databasePath: env.QQ_CODEX_DATABASE_PATH ?? "runtime/qq-codex-bridge.sqlite",
    runtime: {
      listenHost: env.QQ_CODEX_LISTEN_HOST ?? "127.0.0.1",
      listenPort: Number(env.QQ_CODEX_LISTEN_PORT ?? "3100"),
      webhookPath: env.QQ_CODEX_WEBHOOK_PATH ?? "/webhooks/qq"
    },
    qqBot: fallbackQqBot,
    qqBots: resolveQqBotConfigs(env, fallbackQqBot),
    weixin: fallbackWeixin,
    weixinAccounts: resolveWeixinConfigs(env, fallbackWeixin),
    codexDesktop: {
      appName: env.CODEX_APP_NAME ?? "Codex",
      remoteDebuggingPort: Number(env.CODEX_REMOTE_DEBUGGING_PORT ?? "9229")
    },
    conversationProvider: (env.BRIDGE_CONVERSATION_PROVIDER === "chatgpt-desktop"
      ? "chatgpt-desktop"
      : "codex-desktop") as "codex-desktop" | "chatgpt-desktop"
  });
}

function resolveQqBotConfigs(
  env: NodeJS.ProcessEnv,
  fallback: {
    accountId: string;
    appId: string | undefined;
    clientSecret: string | undefined;
    markdownSupport: boolean;
    stt: ReturnType<typeof resolveSttConfig>;
  }
) {
  const jsonConfigs = parseJsonArray(env.QQBOTS_JSON ?? env.QQBOT_ACCOUNTS_JSON);
  if (jsonConfigs) {
    return jsonConfigs.map((item, index) => {
      const record = asRecord(item);
      return {
        accountId: stringValue(record.accountId ?? record.id, `bot${index + 1}`),
        appId: stringValue(record.appId ?? record.appID ?? record.qqbotAppId, ""),
        clientSecret: stringValue(record.clientSecret ?? record.secret ?? record.qqbotClientSecret, ""),
        markdownSupport: booleanValue(record.markdownSupport, fallback.markdownSupport),
        stt: fallback.stt
      };
    });
  }

  const accountIds = splitList(env.QQBOT_ACCOUNT_IDS);
  if (accountIds.length > 0) {
    return accountIds.map((accountId, index) => {
      const suffix = envNameSuffix(accountId);
      return {
        accountId,
        appId: env[`QQBOT_${suffix}_APP_ID`] ?? (index === 0 ? fallback.appId : undefined),
        clientSecret: env[`QQBOT_${suffix}_CLIENT_SECRET`] ?? (index === 0 ? fallback.clientSecret : undefined),
        markdownSupport: booleanEnv(env[`QQBOT_${suffix}_MARKDOWN_SUPPORT`], fallback.markdownSupport),
        stt: fallback.stt
      };
    });
  }

  return [fallback];
}

function resolveWeixinConfigs(
  env: NodeJS.ProcessEnv,
  fallback: {
    enabled: boolean;
    accountId: string;
    webhookPath: string;
    egressBaseUrl: string | null;
    egressToken: string | null;
  }
) {
  const jsonConfigs = parseJsonArray(env.WEIXIN_ACCOUNTS_JSON);
  if (jsonConfigs) {
    return jsonConfigs.map((item, index) => {
      const record = asRecord(item);
      const accountId = stringValue(record.accountId ?? record.id, `account${index + 1}`);
      return {
        enabled: booleanValue(record.enabled, true),
        accountId,
        webhookPath: stringValue(record.webhookPath, `/webhooks/weixin/${accountId}`),
        egressBaseUrl: nullableString(record.egressBaseUrl ?? record.baseUrl),
        egressToken: nullableString(record.egressToken ?? record.token)
      };
    });
  }

  const accountIds = splitList(env.WEIXIN_ACCOUNT_IDS);
  if (accountIds.length > 0) {
    return accountIds.map((accountId, index) => {
      const suffix = envNameSuffix(accountId);
      return {
        enabled: booleanEnv(env[`WEIXIN_${suffix}_ENABLED`], true),
        accountId,
        webhookPath: env[`WEIXIN_${suffix}_WEBHOOK_PATH`] ?? `/webhooks/weixin/${accountId}`,
        egressBaseUrl: env[`WEIXIN_${suffix}_EGRESS_BASE_URL`] ?? (index === 0 ? fallback.egressBaseUrl : null),
        egressToken: env[`WEIXIN_${suffix}_EGRESS_TOKEN`] ?? (index === 0 ? fallback.egressToken : null)
      };
    });
  }

  return fallback.enabled ? [fallback] : [];
}

function resolveSttConfig(env: NodeJS.ProcessEnv) {
  if (env.QQBOT_STT_ENABLED === "false") {
    return null;
  }

  if (env.QQBOT_STT_PROVIDER === "local-whisper-cpp") {
    const binaryPath = env.QQBOT_STT_BINARY_PATH;
    const modelPath = env.QQBOT_STT_MODEL_PATH;
    if (!binaryPath || !modelPath) {
      return null;
    }

    return {
      provider: "local-whisper-cpp" as const,
      binaryPath,
      modelPath,
      ...(env.QQBOT_STT_LANGUAGE ? { language: env.QQBOT_STT_LANGUAGE } : {})
    };
  }

  if (env.QQBOT_STT_PROVIDER === "volcengine-flash") {
    const appId = env.QQBOT_STT_APP_ID;
    const accessKey = env.QQBOT_STT_ACCESS_KEY;
    const resourceId = env.QQBOT_STT_RESOURCE_ID;
    if (!appId || !accessKey || !resourceId) {
      return null;
    }

    return {
      provider: "volcengine-flash" as const,
      endpoint:
        env.QQBOT_STT_ENDPOINT ??
        "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
      appId,
      accessKey,
      resourceId,
      model: env.QQBOT_STT_MODEL ?? "bigmodel"
    };
  }

  const apiKey = env.QQBOT_STT_API_KEY ?? env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const baseUrl = env.QQBOT_STT_BASE_URL ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const model = env.QQBOT_STT_MODEL ?? "whisper-1";
  return {
    provider: "openai-compatible" as const,
    baseUrl,
    apiKey,
    model
  };
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

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return booleanEnv(value, fallback);
  }
  return fallback;
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return value === "true" || value === "1";
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
