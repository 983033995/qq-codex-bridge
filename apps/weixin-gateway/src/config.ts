import { z } from "zod";

export const weixinGatewayConfigSchema = z.object({
  listenHost: z.string().min(1),
  listenPort: z.number().int().positive(),
  bridgeBaseUrl: z.string().url(),
  bridgeWebhookPath: z.string().startsWith("/"),
  expectedBearerToken: z.string().min(1).nullable(),
  messageStorePath: z.string().min(1),
  recentMessageLimit: z.number().int().positive()
});

export type WeixinGatewayConfig = z.infer<typeof weixinGatewayConfigSchema>;

export function loadWeixinGatewayConfigFromEnv(env: NodeJS.ProcessEnv): WeixinGatewayConfig {
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
    recentMessageLimit: Number(env.WEIXIN_GATEWAY_RECENT_MESSAGE_LIMIT ?? "100")
  });
}
