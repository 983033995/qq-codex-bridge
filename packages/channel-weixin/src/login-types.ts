export type WeixinLoginStatus =
  | "logged_out"
  | "requesting_qr"
  | "awaiting_scan"
  | "scanned"
  | "awaiting_confirmation"
  | "logged_in"
  | "expired"
  | "invalid";

export type WeixinLoginState = {
  accountId: string;
  status: WeixinLoginStatus;
  message: string;
  updatedAt: string;
  qrCodeContent?: string;
  expiresAt?: string;
};

export type WeixinLoginCredential = {
  token: string;
  baseUrl: string;
  userId?: string;
};

export type WeixinQrSession = {
  sessionId: string;
  qrCodeContent: string;
};

export type WeixinQrPollResult =
  | { status: "wait" }
  | { status: "scanned" }
  | { status: "awaiting_confirmation"; redirectBaseUrl?: string }
  | { status: "expired" }
  | { status: "confirmed"; credential: WeixinLoginCredential }
  | { status: "invalid" };

export interface WeixinLoginProvider {
  createQr(signal: AbortSignal): Promise<WeixinQrSession>;
  poll(sessionId: string, baseUrl: string, signal: AbortSignal): Promise<WeixinQrPollResult>;
}
