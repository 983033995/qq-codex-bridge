import type { DeliveryRecord, InboundMessage, OutboundDraft } from "../../domain/src/message.js";

export interface QqIngressPort {
  onMessage(handler: (message: InboundMessage) => Promise<void>): Promise<void>;
}

export interface QqEgressPort {
  deliver(draft: OutboundDraft): Promise<DeliveryRecord>;
}
