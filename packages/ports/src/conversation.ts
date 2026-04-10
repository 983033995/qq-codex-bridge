import type { CodexThreadSummary, DriverBinding } from "../../domain/src/driver.js";
import type { InboundMessage, OutboundDraft } from "../../domain/src/message.js";

export type ConversationRunOptions = {
  onDraft?: (draft: OutboundDraft) => Promise<void>;
};

export interface DesktopDriverPort {
  ensureAppReady(): Promise<void>;
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

export interface ConversationProviderPort {
  runTurn(
    message: InboundMessage,
    options?: ConversationRunOptions
  ): Promise<OutboundDraft[]>;
}
