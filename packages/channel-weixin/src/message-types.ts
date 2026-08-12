export type WeixinRawMessage = {
  from_user_id?: string;
  message_id?: string;
  seq?: number;
  session_id?: string;
  context_token?: string;
  message_type?: number;
  message_state?: number;
  item_list?: Array<{
    type?: number;
    text_item?: { text?: string };
    image_item?: { media?: WeixinCdnMedia; mid_size?: number };
    voice_item?: { text?: string; media?: WeixinCdnMedia; size?: number };
    file_item?: {
      media?: WeixinCdnMedia;
      file_name?: string;
      md5?: string;
      len?: string | number;
    };
    video_item?: {
      media?: WeixinCdnMedia;
      video_size?: number;
      video_md5?: string;
      thumb_media?: WeixinCdnMedia;
    };
  }>;
};

export type WeixinCdnMedia = {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
};

export type WeixinMessageAttachment = {
  id: string;
  kind: "image" | "audio" | "video" | "file";
  localPath: string;
  mimeType: string;
  size: number;
  name?: string;
  transcript?: string;
};

export type WeixinInboundTextMessage = {
  accountId: string;
  providerMessageId: string;
  senderId: string;
  peerId: string;
  chatType: "c2c";
  sequence: number;
  receivedAt: string;
  text: string;
  attachments: WeixinMessageAttachment[];
};

export type WeixinTextDelivery = {
  deliveryKey: string;
  accountId: string;
  peerId: string;
  chatType: "c2c" | "group";
  text: string;
  attachments?: WeixinMessageAttachment[];
};

export type WeixinMessageCredential = {
  token: string;
  baseUrl: string;
};

export interface WeixinMessageState {
  getCursor(accountId: string): string;
  setCursor(accountId: string, cursor: string): Promise<void>;
  getContextToken(accountId: string, peerId: string): string;
  setContextToken(accountId: string, peerId: string, token: string): Promise<void>;
}
