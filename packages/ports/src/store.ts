import type { BridgeSession, BridgeSessionStatus } from "../../domain/src/session.js";
import type { InboundMessage, OutboundDraft } from "../../domain/src/message.js";

export interface SessionStorePort {
  getSession(sessionKey: string): Promise<BridgeSession | null>;
  createSession(session: BridgeSession): Promise<void>;
  updateSessionStatus(
    sessionKey: string,
    status: BridgeSessionStatus,
    lastError?: string | null
  ): Promise<void>;
  updateBinding(sessionKey: string, codexThreadRef: string | null): Promise<void>;
  withSessionLock<T>(sessionKey: string, work: () => Promise<T>): Promise<T>;
}

export interface TranscriptStorePort {
  recordInbound(message: InboundMessage): Promise<void>;
  recordOutbound(draft: OutboundDraft): Promise<void>;
  hasInbound(messageId: string): Promise<boolean>;
}
