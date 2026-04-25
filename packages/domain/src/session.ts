export enum BridgeSessionStatus {
  Active = "active",
  NeedsRebind = "needs_rebind",
  DriverUnhealthy = "driver_unhealthy",
  Paused = "paused"
}

export type SessionPeer = {
  accountKey: string;
  peerKey: string;
  chatType: "c2c" | "group";
  peerId: string;
};

export type BridgeSession = SessionPeer & {
  sessionKey: string;
  codexThreadRef: string | null;
  lastCodexTurnId: string | null;
  skillContextKey: string | null;
  status: BridgeSessionStatus;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastError: string | null;
};
