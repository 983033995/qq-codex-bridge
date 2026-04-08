import type { DeliveryRecord, OutboundDraft } from "../../../domain/src/message.js";
import type { QqEgressPort } from "../../../ports/src/qq.js";

export function chunkTextForQq(text: string, limit = 5000): string[] {
  const chunks: string[] = [];

  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit));
  }

  return chunks.length > 0 ? chunks : [""];
}

export class QqSender implements QqEgressPort {
  async deliver(draft: OutboundDraft): Promise<DeliveryRecord> {
    return {
      jobId: draft.draftId,
      sessionKey: draft.sessionKey,
      providerMessageId: null,
      deliveredAt: new Date().toISOString()
    };
  }
}
