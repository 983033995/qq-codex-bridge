import type { CodexThreadSummary, DriverBinding } from "../../domain/src/driver.js";
import type { InboundMessage, OutboundDraft } from "../../domain/src/message.js";

export interface DesktopDriverPort {
  ensureAppReady(): Promise<void>;
  openOrBindSession(sessionKey: string, binding: DriverBinding | null): Promise<DriverBinding>;
  listRecentThreads(limit: number): Promise<CodexThreadSummary[]>;
  switchToThread(sessionKey: string, threadRef: string): Promise<DriverBinding>;
  createThread(sessionKey: string, seedPrompt: string): Promise<DriverBinding>;
  sendUserMessage(binding: DriverBinding, message: InboundMessage): Promise<void>;
  collectAssistantReply(binding: DriverBinding): Promise<OutboundDraft[]>;
  markSessionBroken(sessionKey: string, reason: string): Promise<void>;
}

export interface ConversationProviderPort {
  runTurn(message: InboundMessage): Promise<OutboundDraft[]>;
}
