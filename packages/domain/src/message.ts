export type InboundMessage = {
  messageId: string;
  accountKey: string;
  sessionKey: string;
  peerKey: string;
  chatType: "c2c" | "group";
  senderId: string;
  text: string;
  receivedAt: string;
};

export type OutboundDraft = {
  draftId: string;
  sessionKey: string;
  text: string;
  createdAt: string;
};

export type DeliveryRecord = {
  jobId: string;
  sessionKey: string;
  providerMessageId: string | null;
  deliveredAt: string;
};
