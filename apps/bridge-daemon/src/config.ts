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
    clientSecret: z.string().min(1)
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
      clientSecret: env.QQBOT_CLIENT_SECRET
    },
    codexDesktop: {
      appName: env.CODEX_APP_NAME ?? "Codex",
      remoteDebuggingPort: Number(env.CODEX_REMOTE_DEBUGGING_PORT ?? "9229")
    }
  });
}
