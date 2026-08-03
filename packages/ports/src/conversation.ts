import type { CodexControlState, CodexThreadSummary, DriverBinding } from "../../domain/src/driver.js";
import type { InboundMessage, OutboundDraft, TurnEvent } from "../../domain/src/message.js";

export type ConversationRunOptions = {
  onDraft?: (draft: OutboundDraft) => Promise<void>;
  onTurnEvent?: (event: TurnEvent) => Promise<void>;
};

export interface DesktopDriverPort {
  ensureAppReady(): Promise<void>;
  getControlState(binding?: DriverBinding | null): Promise<CodexControlState>;
  getQuotaSummary(): Promise<string | null>;
  switchModel(model: string): Promise<CodexControlState>;
  openOrBindSession(sessionKey: string, binding: DriverBinding | null): Promise<DriverBinding>;
  listRecentThreads(limit: number): Promise<CodexThreadSummary[]>;
  switchToThread(sessionKey: string, threadRef: string): Promise<DriverBinding>;
  createThread(sessionKey: string, seedPrompt: string): Promise<DriverBinding>;
  sendUserMessage(binding: DriverBinding, message: InboundMessage): Promise<void>;
  collectAssistantReply(
    binding: DriverBinding,
    options?: ConversationRunOptions
  ): Promise<OutboundDraft[]>;
  markSessionBroken(sessionKey: string, reason: string): Promise<void>;
}

export type DesktopTransportMode = "auto" | "app-server" | "cdp";
export type DesktopTransportName = Exclude<DesktopTransportMode, "auto">;

export type DesktopTransportStatus = {
  configured: DesktopTransportMode;
  active: DesktopTransportName | null;
  appServerAvailable: boolean | null;
  cdpAvailable: boolean | null;
  lastProbedAt: string | null;
  lastError: string | null;
};

export interface DesktopTransportStatusPort {
  getTransportStatus(): DesktopTransportStatus;
}

export interface ConversationProviderPort {
  runTurn(
    message: InboundMessage,
    options?: ConversationRunOptions
  ): Promise<OutboundDraft[]>;
}
