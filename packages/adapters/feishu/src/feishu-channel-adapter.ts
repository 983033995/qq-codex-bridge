import * as Lark from "@larksuiteoapi/node-sdk";
import { FeishuIngress } from "./feishu-ingress.js";
import { FeishuPushEgress } from "./feishu-push-egress.js";
import { FeishuSender } from "./feishu-sender.js";

export type FeishuChannelAdapter = {
  ingress: FeishuIngress;
  egress: FeishuSender;
  pushEgress: FeishuPushEgress;
};

export function createFeishuChannelAdapter(config: {
  accountKey: string;
  appId: string;
  appSecret: string;
  onDispatchError?: (error: Error) => void;
}): FeishuChannelAdapter {
  const client = new Lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: Lark.Domain.Feishu
  });
  const wsClient = new Lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.warn
  });
  const eventDispatcher = new Lark.EventDispatcher({ loggerLevel: Lark.LoggerLevel.warn });
  return {
    ingress: new FeishuIngress({
      accountKey: config.accountKey,
      wsClient,
      eventDispatcher,
      onDispatchError: config.onDispatchError
    }),
    egress: new FeishuSender(client),
    pushEgress: new FeishuPushEgress(client)
  };
}
