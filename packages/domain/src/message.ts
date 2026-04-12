export enum MediaArtifactKind {
  Image = "image",
  Audio = "audio",
  Video = "video",
  File = "file"
}

export type MediaArtifact = {
  kind: MediaArtifactKind;
  sourceUrl: string;
  localPath: string;
  mimeType: string;
  fileSize: number;
  originalName: string;
  transcript?: string | null;
  transcriptSource?: "stt" | "asr" | "fallback" | null;
  extractedText?: string | null;
};

export type InboundMessage = {
  messageId: string;
  accountKey: string;
  sessionKey: string;
  peerKey: string;
  chatType: "c2c" | "group";
  senderId: string;
  text: string;
  mediaArtifacts?: MediaArtifact[];
  receivedAt: string;
};

export type OutboundDraft = {
  draftId: string;
  sessionKey: string;
  text: string;
  mediaArtifacts?: MediaArtifact[];
  createdAt: string;
  replyToMessageId?: string;
};

export enum TurnEventType {
  Delta = "turn.delta",
  Status = "turn.status",
  Completed = "turn.completed"
}

export type TurnEventPayload = {
  text?: string;
  fullText?: string;
  mediaReferences?: string[];
  replyToMessageId?: string;
  status?: string;
  completionReason?: "stable" | "timeout_flush";
};

export type TurnEvent = {
  sessionKey: string;
  turnId: string;
  sequence: number;
  eventType: TurnEventType;
  createdAt: string;
  isFinal: boolean;
  payload: TurnEventPayload;
};

export type DeliveryRecord = {
  jobId: string;
  sessionKey: string;
  providerMessageId: string | null;
  deliveredAt: string;
};

export type ConversationEntry = {
  direction: "inbound" | "outbound";
  text: string;
  mediaArtifacts?: MediaArtifact[];
  createdAt: string;
};
