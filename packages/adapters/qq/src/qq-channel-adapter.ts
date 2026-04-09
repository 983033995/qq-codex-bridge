import { QqGateway } from "./qq-gateway.js";
import { QqApiClient } from "./qq-api-client.js";
import { QqSender } from "./qq-sender.js";

export function createQqChannelAdapter(apiClient?: QqApiClient) {
  return {
    ingress: new QqGateway(),
    egress: new QqSender(apiClient)
  };
}
