import type { DeliveryRecord, OutboundDraft } from "../../../domain/src/message.js";
import type { QqEgressPort } from "../../../ports/src/qq.js";
import type { QqApiClient } from "./qq-api-client.js";

export function chunkTextForQq(text: string, limit = 5000): string[] {
  const chunks: string[] = [];

  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit));
  }

  return chunks.length > 0 ? chunks : [""];
}

export class QqSender implements QqEgressPort {
  constructor(private readonly apiClient?: Pick<QqApiClient, "sendC2CMessage" | "sendGroupMessage">) {}

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

    const [, peerKey = ""] = draft.sessionKey.split("::");
    const segments = peerKey.split(":");
    const chatType = segments[1];
    const peerId = segments.slice(2).join(":");

    if (chatType === "c2c") {
      return this.apiClient.sendC2CMessage(peerId, draft.text, draft.draftId);
    }

    if (chatType === "group") {
      return this.apiClient.sendGroupMessage(peerId, draft.text, draft.draftId);
    }

    return null;
  }
}
