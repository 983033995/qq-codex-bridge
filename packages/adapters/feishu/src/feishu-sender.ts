import { MediaArtifactKind, type DeliveryRecord, type MediaArtifact, type OutboundDraft } from "../../../domain/src/message.js";
import type { ChatEgressPort } from "../../../ports/src/chat.js";
import { buildMediaArtifactFromReference, parseQqMediaSegments } from "../../qq/src/qq-media-parser.js";
import { sendFeishuFile, sendFeishuImage, sendFeishuText } from "./feishu-message-client.js";
import type { FeishuMessageClient } from "./feishu-types.js";

export class FeishuSender implements ChatEgressPort {
  constructor(private readonly client: FeishuMessageClient) {}

  async deliver(draft: OutboundDraft): Promise<DeliveryRecord> {
    const targetId = parseFeishuSessionTarget(draft.sessionKey);
    let lastProviderMessageId: string | null = null;
    const deliveredArtifactKeys = new Set<string>();
    let sentAnything = false;
    let textSegmentIndex = 0;

    for (const segment of parseQqMediaSegments(draft.text)) {
      if (segment.type === "text") {
        const text = segment.text.trim();
        if (!text) {
          continue;
        }
        lastProviderMessageId = await sendFeishuText(this.client, targetId, text, {
          rich: shouldUseFeishuRichText(text),
          uuid: `${draft.draftId}-text-${textSegmentIndex++}`
        });
        sentAnything = true;
        continue;
      }

      const artifact = buildMediaArtifactFromReference(segment.reference);
      const key = buildArtifactKey(artifact);
      deliveredArtifactKeys.add(key);
      lastProviderMessageId = await this.deliverArtifact(targetId, draft.draftId, artifact);
      sentAnything = true;
    }

    for (const artifact of draft.mediaArtifacts ?? []) {
      const key = buildArtifactKey(artifact);
      if (deliveredArtifactKeys.has(key)) {
        continue;
      }
      deliveredArtifactKeys.add(key);
      lastProviderMessageId = await this.deliverArtifact(targetId, draft.draftId, artifact);
      sentAnything = true;
    }

    if (!sentAnything) {
      const fallbackText = draft.text.trim();
      lastProviderMessageId = fallbackText
        ? await sendFeishuText(this.client, targetId, fallbackText, {
            rich: shouldUseFeishuRichText(fallbackText),
            uuid: draft.draftId
          })
        : null;
    }

    return {
      jobId: draft.draftId,
      sessionKey: draft.sessionKey,
      providerMessageId: lastProviderMessageId,
      deliveredAt: draft.createdAt
    };
  }

  private async deliverArtifact(
    targetId: string,
    draftId: string,
    artifact: MediaArtifact
  ): Promise<string | null> {
    const key = buildArtifactKey(artifact);
    const source = artifact.localPath || artifact.sourceUrl;

    if (artifact.kind === MediaArtifactKind.Image) {
      try {
        return await sendFeishuImage(this.client, targetId, source, `${draftId}-image-${key}`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return sendFeishuText(
          this.client,
          targetId,
          `图片发送失败：${artifact.originalName || source}\n${reason}`,
          { uuid: `${draftId}-image-error-${key}` }
        );
      }
    }

    try {
      return await sendFeishuFile(
        this.client,
        targetId,
        source,
        artifact.originalName || describeMediaKind(artifact.kind),
        `${draftId}-file-${key}`
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return sendFeishuText(
        this.client,
        targetId,
        `${describeMediaKind(artifact.kind)}发送失败：${artifact.originalName || source}\n${reason}`,
        { uuid: `${draftId}-file-error-${key}` }
      );
    }
  }
}

function describeMediaKind(kind: MediaArtifactKind): string {
  switch (kind) {
    case MediaArtifactKind.Audio:
      return "语音";
    case MediaArtifactKind.Video:
      return "视频";
    case MediaArtifactKind.File:
    default:
      return "文件";
  }
}

export function shouldUseFeishuRichText(text: string): boolean {
  if (!text.trim()) {
    return false;
  }

  return (
    /\[[^\]]+\]\(https?:\/\/[^\s)]+\)/.test(text) ||
    /^\s*#{1,6}\s/m.test(text) ||
    /^\s*[-*+]\s/m.test(text) ||
    /^\s*\d+\.\s/m.test(text) ||
    /\*\*[^*]+\*\*/.test(text) ||
    /```[\s\S]*```/.test(text) ||
    // /t /help 等控制指令会输出 Markdown 表格；不识别时会落到 msg_type=text，
    // 飞书客户端就会原样显示管道符而不是渲染表格。
    /^\s*\|.+\|\s*$/m.test(text) ||
    /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/m.test(text)
  );
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

function buildArtifactKey(artifact: MediaArtifact): string {
  return [
    artifact.kind,
    artifact.localPath || "",
    artifact.sourceUrl || "",
    artifact.originalName || ""
  ].join("::");
}
