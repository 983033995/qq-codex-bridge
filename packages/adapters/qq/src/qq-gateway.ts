import type { InboundMessage } from "../../../domain/src/message.js";
import type { QqIngressPort } from "../../../ports/src/qq.js";
import { normalizeC2CMessage, normalizeGroupMessage } from "./qq-normalizer.js";

type QqGatewayConfig = {
  accountKey: string;
};

type QqC2CEvent = {
  t: "C2C_MESSAGE_CREATE";
  d: {
    id: string;
    content: string;
    timestamp: string;
    author: { user_openid: string };
  };
};

type QqGroupEvent = {
  t: "GROUP_AT_MESSAGE_CREATE";
  d: {
    id: string;
    content: string;
    timestamp: string;
    group_openid: string;
    author: { member_openid: string };
  };
};

type QqRawEvent =
  | QqC2CEvent
  | QqGroupEvent
  | {
      t: string;
      d: Record<string, unknown>;
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
    if (this.isC2CEvent(event)) {
      await this.dispatch(normalizeC2CMessage(event.d, this.config.accountKey));
      return;
    }

    if (this.isGroupEvent(event)) {
      await this.dispatch(normalizeGroupMessage(event.d, this.config.accountKey));
    }
  }

  private isC2CEvent(event: QqRawEvent): event is QqC2CEvent {
    return event.t === "C2C_MESSAGE_CREATE";
  }

  private isGroupEvent(event: QqRawEvent): event is QqGroupEvent {
    return event.t === "GROUP_AT_MESSAGE_CREATE";
  }
}
