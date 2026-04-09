import type { DeliveryRecord, MediaArtifact, OutboundDraft } from "../../../domain/src/message.js";
import type { QqEgressPort } from "../../../ports/src/qq.js";
import type { QqApiClient } from "./qq-api-client.js";
import { buildMediaArtifactFromReference, parseQqMediaSegments } from "./qq-media-parser.js";

export function chunkTextForQq(text: string, limit = 5000): string[] {
  const chunks: string[] = [];

  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit));
  }

  return chunks.length > 0 ? chunks : [""];
}

export class QqSender implements QqEgressPort {
  constructor(
    private readonly apiClient?: Pick<
      QqApiClient,
      "sendC2CMessage" | "sendGroupMessage" | "sendC2CMediaArtifact" | "sendGroupMediaArtifact"
    >
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

  private async sendTextSegment(
    target: { chatType: string; peerId: string },
    text: string,
    replyToMessageId: string
  ): Promise<string | null> {
    if (!text) {
      return null;
    }

    let lastProviderMessageId: string | null = null;
    for (const chunk of chunkTextForQq(text)) {
      if (!chunk) {
        continue;
      }

      if (target.chatType === "c2c") {
        lastProviderMessageId = await this.apiClient!.sendC2CMessage(target.peerId, chunk, replyToMessageId);
        continue;
      }

      if (target.chatType === "group") {
        lastProviderMessageId = await this.apiClient!.sendGroupMessage(target.peerId, chunk, replyToMessageId);
        continue;
      }
    }

    return lastProviderMessageId;
  }

  private async sendMediaArtifact(
    target: { chatType: string; peerId: string },
    artifact: MediaArtifact,
    replyToMessageId: string
  ): Promise<string | null> {
    if (target.chatType === "c2c" && this.apiClient?.sendC2CMediaArtifact) {
      return this.apiClient.sendC2CMediaArtifact(target.peerId, artifact, replyToMessageId);
    }

    if (target.chatType === "group" && this.apiClient?.sendGroupMediaArtifact) {
      return this.apiClient.sendGroupMediaArtifact(target.peerId, artifact, replyToMessageId);
    }

    return null;
  }

  private buildMediaFailureText(artifact: MediaArtifact, error: unknown): string {
    const filename = artifact.originalName || artifact.localPath || artifact.sourceUrl || "未知附件";
    const reason = error instanceof Error ? error.message : String(error);
    return `媒体发送失败：${filename}\n${reason}`;
  }

  private async deliverThroughApiClient(draft: OutboundDraft): Promise<string | null> {
    if (!this.apiClient) {
      return null;
    }

    const replyToMessageId = draft.replyToMessageId ?? draft.draftId;
    const target = parseSessionTarget(draft.sessionKey);
    let lastProviderMessageId: string | null = null;

    for (const segment of parseQqMediaSegments(draft.text)) {
      if (segment.type === "text") {
        lastProviderMessageId = await this.sendTextSegment(target, segment.text, replyToMessageId);
        continue;
      }

      const artifact = buildMediaArtifactFromReference(segment.reference);
      try {
        lastProviderMessageId = await this.sendMediaArtifact(
          target,
          artifact,
          replyToMessageId
        );
      } catch (error) {
        lastProviderMessageId = await this.sendTextSegment(
          target,
          this.buildMediaFailureText(artifact, error),
          replyToMessageId
        );
      }
    }

    if (draft.mediaArtifacts?.length) {
      for (const artifact of draft.mediaArtifacts) {
        try {
          lastProviderMessageId = await this.sendMediaArtifact(target, artifact, replyToMessageId);
        } catch (error) {
          lastProviderMessageId = await this.sendTextSegment(
            target,
            this.buildMediaFailureText(artifact, error),
            replyToMessageId
          );
        }
      }
    }

    if (lastProviderMessageId !== null) {
      return lastProviderMessageId;
    }

    return this.sendTextSegment(target, draft.text, replyToMessageId);
  }

}

function parseSessionTarget(sessionKey: string): { chatType: string; peerId: string } {
  const [, peerKey = ""] = sessionKey.split("::");
  const segments = peerKey.split(":");

  return {
    chatType: segments[1] ?? "",
    peerId: segments.slice(2).join(":")
  };
}
