import type {
  DeliveryRecord,
  InboundMessage,
  MediaArtifact,
  OutboundDraft
} from "../../domain/src/message.js";

export interface ChatIngressPort {
  onMessage(handler: (message: InboundMessage) => Promise<void>): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ChatEgressPort {
  deliver(draft: OutboundDraft): Promise<DeliveryRecord>;
}

export interface ChatMediaDownloadPort {
  downloadMediaArtifact(source: {
    sourceUrl: string;
    originalName?: string | null;
    mimeType?: string | null;
    fileSize?: number | null;
    voiceWavUrl?: string | null;
    asrReferText?: string | null;
  }): Promise<MediaArtifact>;
}

export interface ChatMediaSendPort {
  sendMedia(draft: {
    sessionKey: string;
    mediaArtifacts: MediaArtifact[];
  }): Promise<unknown>;
}
