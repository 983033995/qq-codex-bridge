import { QqGateway } from "./qq-gateway.js";
import { QqSender } from "./qq-sender.js";

export function createQqChannelAdapter() {
  return {
    ingress: new QqGateway(),
    egress: new QqSender()
  };
}
