import type { DeliveryRecord, OutboundDraft } from "../../../domain/src/message.js";
import type { ChatEgressPort } from "../../../ports/src/chat.js";
import type { WeixinHttpClient } from "./weixin-http-client.js";

export class WeixinSender implements ChatEgressPort {
  constructor(
    private readonly apiClient?: Pick<WeixinHttpClient, "sendTextMessage">
  ) {}

  async deliver(draft: OutboundDraft): Promise<DeliveryRecord> {
    const providerMessageId = await this.deliverThroughApiClient(draft);

    return {
      jobId: draft.draftId,
      sessionKey: draft.sessionKey,
      providerMessageId,
      deliveredAt: draft.createdAt
    };
  }

  private async deliverThroughApiClient(draft: OutboundDraft): Promise<string | null> {
    if (!this.apiClient) {
      return null;
    }

    const target = parseSessionTarget(draft.sessionKey);
    return this.apiClient.sendTextMessage({
      peerId: target.peerId,
      chatType: target.chatType,
      content: draft.text,
      replyToMessageId: draft.replyToMessageId
    });
  }
}

function parseSessionTarget(sessionKey: string): { chatType: "c2c" | "group"; peerId: string } {
  const parts = sessionKey.split("::");
  const scope = parts.at(-1) ?? "";
  const segments = scope.split(":");
  const chatType = segments.at(-2);
  const peerId = segments.at(-1);

  if ((chatType !== "c2c" && chatType !== "group") || !peerId) {
    throw new Error(`Unable to parse channel session key: ${sessionKey}`);
  }

  return {
    chatType,
    peerId
  };
}
