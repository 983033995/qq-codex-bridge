export type SetupChannel = "qq" | "weixin" | "feishu";

export type SetupStatus =
  | "awaiting_input"
  | "requesting_qr"
  | "awaiting_scan"
  | "awaiting_confirmation"
  | "restart_required"
  | "connected"
  | "action_required"
  | "failed"
  | "cancelled";

export type SetupArtifact =
  | { type: "qr_code"; content: string; expiresAt?: string }
  | { type: "form"; fields: Array<{ name: string; secret: boolean; required: boolean }> };

export type SetupSession = {
  setupId: string;
  channel: SetupChannel;
  accountId: string;
  status: SetupStatus;
  message: string;
  artifact: SetupArtifact | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SetupSubmission = {
  appId?: string;
  clientSecret?: string;
};
