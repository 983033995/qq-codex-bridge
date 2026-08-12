import type { DeliveryRecord, OutboundDraft } from "../../../domain/src/message.js";
import type { ChatEgressPort } from "../../../ports/src/chat.js";
import { sendFeishuText } from "./feishu-message-client.js";
import type { FeishuMessageClient } from "./feishu-types.js";

export class FeishuSender implements ChatEgressPort {
  constructor(private readonly client: FeishuMessageClient) {}

  async deliver(draft: OutboundDraft): Promise<DeliveryRecord> {
    const targetId = parseFeishuSessionTarget(draft.sessionKey);
    const providerMessageId = await sendFeishuText(this.client, targetId, draft.text, {
      rich: draft.format === "markdown",
      uuid: draft.draftId
    });
    return {
      jobId: draft.draftId,
      sessionKey: draft.sessionKey,
      providerMessageId,
      deliveredAt: draft.createdAt
    };
  }
}

function parseFeishuSessionTarget(sessionKey: string): string {
  const [accountKey, scope, ...extra] = sessionKey.split("::");
  const parts = scope?.split(":") ?? [];
  const targetId = parts.at(-1)?.trim();
  if (!accountKey.startsWith("feishu:") || extra.length > 0 || !targetId) {
    throw new Error(`Unable to parse Feishu session key: ${sessionKey}`);
  }
  return targetId;
}
