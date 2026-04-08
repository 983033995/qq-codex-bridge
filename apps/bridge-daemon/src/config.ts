import { z } from "zod";

export const appConfigSchema = z.object({
  databasePath: z.string().min(1),
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
