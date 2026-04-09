import type { InboundMessage } from "../../../domain/src/message.js";
import type { QqMediaDownloadPort } from "../../../ports/src/qq.js";
import type { QqIngressPort } from "../../../ports/src/qq.js";
import { normalizeC2CMessage, normalizeGroupMessage } from "./qq-normalizer.js";

type QqGatewayConfig = {
  accountKey: string;
  mediaDownloader?: QqMediaDownloadPort;
};

type QqC2CEvent = {
  t: "C2C_MESSAGE_CREATE";
  d: {
    id: string;
    content: string;
    timestamp: string;
    author: { user_openid: string };
    attachments?: Array<{
      content_type: string;
      filename?: string;
      size?: number;
      url: string;
      voice_wav_url?: string;
    }>;
  };
};

type QqGroupEvent = {
  t: "GROUP_AT_MESSAGE_CREATE" | "GROUP_MESSAGE_CREATE";
  d: {
    id: string;
    content: string;
    timestamp: string;
    group_openid: string;
    author: { member_openid: string };
    attachments?: Array<{
      content_type: string;
      filename?: string;
      size?: number;
      url: string;
      voice_wav_url?: string;
    }>;
  };
};

type QqRawEvent =
  | QqC2CEvent
  | QqGroupEvent
  | {
      t: string;
      d: Record<string, unknown>;
    };

export class QqGateway implements QqIngressPort {
  private handler: ((message: InboundMessage) => Promise<void>) | null = null;

  constructor(private readonly config: QqGatewayConfig) {}

  async onMessage(handler: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.handler = handler;
  }

  async start(): Promise<void> {
    // no-op: this class only normalizes and dispatches payloads.
  }

  async stop(): Promise<void> {
    // no-op: this class only normalizes and dispatches payloads.
  }

  async dispatch(message: InboundMessage): Promise<void> {
    if (this.handler) {
      await this.handler(message);
    }
  }

  async dispatchPayload(event: QqRawEvent): Promise<void> {
    if (this.isC2CEvent(event)) {
      const mediaArtifacts = await this.downloadMediaArtifacts(event.d.attachments);
      await this.dispatch(normalizeC2CMessage(event.d, this.config.accountKey, mediaArtifacts));
      return;
    }

    if (this.isGroupEvent(event)) {
      const mediaArtifacts = await this.downloadMediaArtifacts(event.d.attachments);
      await this.dispatch(normalizeGroupMessage(event.d, this.config.accountKey, mediaArtifacts));
    }
  }

  private isC2CEvent(event: QqRawEvent): event is QqC2CEvent {
    return event.t === "C2C_MESSAGE_CREATE";
  }

  private isGroupEvent(event: QqRawEvent): event is QqGroupEvent {
    return event.t === "GROUP_AT_MESSAGE_CREATE" || event.t === "GROUP_MESSAGE_CREATE";
  }

  private async downloadMediaArtifacts(
    attachments:
      | Array<{
          content_type: string;
          filename?: string;
          size?: number;
          url: string;
          voice_wav_url?: string;
        }>
      | undefined
  ) {
    if (!attachments?.length || !this.config.mediaDownloader) {
      return [];
    }

    const artifacts = await Promise.all(
      attachments.map((attachment) =>
        this.config.mediaDownloader!.downloadMediaArtifact({
          sourceUrl: attachment.voice_wav_url || attachment.url,
          originalName: attachment.filename ?? null,
          mimeType: attachment.content_type ?? null,
          fileSize: attachment.size ?? null
        })
      )
    );

    return artifacts;
  }
}
