import type { InboundMessage } from "../../../domain/src/message.js";
import type { QqIngressPort } from "../../../ports/src/qq.js";

export class QqGateway implements QqIngressPort {
  private handler: ((message: InboundMessage) => Promise<void>) | null = null;

  async onMessage(handler: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.handler = handler;
  }

  async dispatch(message: InboundMessage): Promise<void> {
    if (this.handler) {
      await this.handler(message);
    }
  }
}
