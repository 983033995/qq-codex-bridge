import type { InboundMessage } from "../../../domain/src/message.js";
import type { QqIngressPort } from "../../../ports/src/qq.js";
import { normalizeC2CMessage, normalizeGroupMessage } from "./qq-normalizer.js";

type QqGatewayConfig = {
  accountKey: string;
};

type QqRawEvent =
  | {
      t: "C2C_MESSAGE_CREATE";
      d: {
        id: string;
        content: string;
        timestamp: string;
        author: { user_openid: string };
      };
    }
  | {
      t: "GROUP_AT_MESSAGE_CREATE";
      d: {
        id: string;
        content: string;
        timestamp: string;
        group_openid: string;
        author: { member_openid: string };
      };
    };

export class QqGateway implements QqIngressPort {
  private handler: ((message: InboundMessage) => Promise<void>) | null = null;

  constructor(private readonly config: QqGatewayConfig) {}

  async onMessage(handler: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.handler = handler;
  }

  async dispatch(message: InboundMessage): Promise<void> {
    if (this.handler) {
      await this.handler(message);
    }
  }

  async dispatchPayload(event: QqRawEvent): Promise<void> {
    if (event.t === "C2C_MESSAGE_CREATE") {
      await this.dispatch(normalizeC2CMessage(event.d, this.config.accountKey));
      return;
    }

    await this.dispatch(normalizeGroupMessage(event.d, this.config.accountKey));
  }
}
