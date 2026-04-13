import { z } from "zod";

export const appConfigSchema = z.object({
  databasePath: z.string().min(1),
  runtime: z.object({
    listenHost: z.string().min(1),
    listenPort: z.number().int().positive(),
    webhookPath: z.string().startsWith("/")
  }),
  qqBot: z.object({
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
  }),
  weixin: z.object({
    enabled: z.boolean(),
    accountId: z.string().min(1),
    webhookPath: z.string().startsWith("/"),
    egressBaseUrl: z.string().url().nullable(),
    egressToken: z.string().min(1).nullable()
  }),
  codexDesktop: z.object({
    appName: z.string().min(1),
    remoteDebuggingPort: z.number().int().positive()
  })
});

export type AppConfig = z.infer<typeof appConfigSchema>;

export function loadConfigFromEnv(env: NodeJS.ProcessEnv): AppConfig {
  return appConfigSchema.parse({
    databasePath: env.QQ_CODEX_DATABASE_PATH ?? "runtime/qq-codex-bridge.sqlite",
    runtime: {
      listenHost: env.QQ_CODEX_LISTEN_HOST ?? "127.0.0.1",
      listenPort: Number(env.QQ_CODEX_LISTEN_PORT ?? "3100"),
      webhookPath: env.QQ_CODEX_WEBHOOK_PATH ?? "/webhooks/qq"
    },
    qqBot: {
      appId: env.QQBOT_APP_ID,
      clientSecret: env.QQBOT_CLIENT_SECRET,
      markdownSupport: env.QQBOT_MARKDOWN_SUPPORT === "true",
      stt: resolveSttConfig(env)
    },
    weixin: {
      enabled: env.WEIXIN_ENABLED === "true",
      accountId: env.WEIXIN_ACCOUNT_ID ?? "default",
      webhookPath: env.WEIXIN_WEBHOOK_PATH ?? "/webhooks/weixin",
      egressBaseUrl: env.WEIXIN_EGRESS_BASE_URL ?? null,
      egressToken: env.WEIXIN_EGRESS_TOKEN ?? null
    },
    codexDesktop: {
      appName: env.CODEX_APP_NAME ?? "Codex",
      remoteDebuggingPort: Number(env.CODEX_REMOTE_DEBUGGING_PORT ?? "9229")
    }
  });
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
