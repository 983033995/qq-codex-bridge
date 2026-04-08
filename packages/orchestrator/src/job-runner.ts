import type { OutboundDraft } from "../../domain/src/message.js";
import type { QqEgressPort } from "../../ports/src/qq.js";

export async function deliverDrafts(
  egress: QqEgressPort,
  drafts: OutboundDraft[]
): Promise<void> {
  for (const draft of drafts) {
    await egress.deliver(draft);
  }
}
