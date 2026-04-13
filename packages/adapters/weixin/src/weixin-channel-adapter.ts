import { WeixinHttpClient } from "./weixin-http-client.js";
import { WeixinSender } from "./weixin-sender.js";
import {
  normalizeWeixinInboundMessage,
  type WeixinWebhookPayload
} from "./weixin-webhook.js";

export type WeixinChannelAdapter = {
  webhook: {
    routePath: string;
    toInboundMessage(payload: unknown): ReturnType<typeof normalizeWeixinInboundMessage>;
  };
  egress: WeixinSender;
};

export function createWeixinChannelAdapter(config: {
  accountKey: string;
  webhookPath: string;
  egressBaseUrl: string;
  egressToken: string;
}): WeixinChannelAdapter {
  const apiClient = new WeixinHttpClient(config.egressBaseUrl, config.egressToken);

  return {
    webhook: {
      routePath: config.webhookPath,
      toInboundMessage: (payload) =>
        normalizeWeixinInboundMessage(payload as WeixinWebhookPayload, {
          accountKey: config.accountKey
        })
    },
    egress: new WeixinSender(apiClient)
  };
}
