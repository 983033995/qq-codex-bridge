import type {
  ConversationSpace,
  InboundEnvelope
} from "../../domain/src/vnext/index.js";
import type {
  ConversationSpaceRepository,
  MessageLedger
} from "../../ports/src/vnext/index.js";

export type ReceiveInboundMessageResult =
  | { accepted: true; duplicate: false; message: InboundEnvelope }
  | { accepted: false; duplicate: true; message: InboundEnvelope };

export class ReceiveInboundMessage {
  constructor(private readonly deps: {
    spaces: ConversationSpaceRepository;
    messages: MessageLedger;
  }) {}

  async execute(input: {
    space: ConversationSpace;
    message: InboundEnvelope;
  }): Promise<ReceiveInboundMessageResult> {
    if (input.space.spaceId !== input.message.spaceId) {
      throw new Error("Inbound message spaceId does not match its conversation space");
    }

    const space: ConversationSpace = {
      ...input.space,
      lastInboundAt: latestTimestamp(input.space.lastInboundAt, input.message.receivedAt)
    };
    await this.deps.spaces.save(space);

    const dedupeKey = [
      space.channel,
      space.accountId,
      input.message.providerMessageId
    ].join(":");
    const appended = await this.deps.messages.appendInbound(input.message, dedupeKey);
    if (!appended) {
      const existing = await this.deps.messages.findByDedupeKey(dedupeKey);
      if (!existing) {
        throw new Error("Inbound dedupe conflict was reported without an existing ledger entry");
      }
      return { accepted: false, duplicate: true, message: existing };
    }
    return { accepted: true, duplicate: false, message: input.message };
  }
}

function latestTimestamp(current: string | null, candidate: string): string {
  if (!current) {
    return candidate;
  }
  return current >= candidate ? current : candidate;
}
