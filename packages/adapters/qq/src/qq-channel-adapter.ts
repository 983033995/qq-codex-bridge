import { QqGateway } from "./qq-gateway.js";
import { QqApiClient } from "./qq-api-client.js";
import { QqSender } from "./qq-sender.js";

export function createQqChannelAdapter(config: {
  accountKey: string;
  apiClient?: QqApiClient;
}) {
  return {
    ingress: new QqGateway({ accountKey: config.accountKey }),
    egress: new QqSender(config.apiClient)
  };
}
