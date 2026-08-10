import type {
  ChannelAccountId,
  ComponentHealth,
  ConversationSpaceId,
  InboundEnvelope,
  MessageContent
} from "../../../domain/src/vnext/index.js";

export type DeliveryRequest = {
  deliveryKey: string;
  accountId: ChannelAccountId;
  spaceId: ConversationSpaceId;
  content: MessageContent;
  replyToProviderMessageId?: string;
};

export type DeliveryResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; retryable: boolean; code: string; message: string };

export type ChannelHealth = ComponentHealth & {
  accountId: ChannelAccountId;
};

export interface ChannelPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<ChannelHealth>;
  onMessage(handler: (message: InboundEnvelope) => Promise<void>): void;
  deliver(input: DeliveryRequest): Promise<DeliveryResult>;
}
