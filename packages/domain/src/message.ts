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
