import type {
  DeliveryRecord,
  InboundMessage,
  MediaArtifact,
  OutboundDraft
} from "../../domain/src/message.js";

export interface QqIngressPort {
  onMessage(handler: (message: InboundMessage) => Promise<void>): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface QqEgressPort {
  deliver(draft: OutboundDraft): Promise<DeliveryRecord>;
}

export interface QqMediaDownloadPort {
  downloadMediaArtifact(source: {
    sourceUrl: string;
    originalName?: string | null;
    mimeType?: string | null;
    fileSize?: number | null;
  }): Promise<MediaArtifact>;
}

export interface QqMediaSendPort {
  sendMedia(draft: {
    sessionKey: string;
    mediaArtifacts: MediaArtifact[];
  }): Promise<unknown>;
}
