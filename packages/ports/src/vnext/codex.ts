import type { CodexThread, ComponentHealth, MessageContent } from "../../../domain/src/vnext/index.js";

export type CodexHealth = ComponentHealth & {
  capabilities: CodexCapabilities;
};

export type CodexCapabilities = {
  listThreads: boolean;
  createThread: boolean;
  renameThread: boolean;
  forkThread: boolean;
  concurrentThreads: boolean;
  media: boolean;
};

export type ListThreadsInput = {
  limit: number;
  cursor?: string;
};

export type CreateThreadInput = {
  title?: string;
  cwd?: string;
};

export type StartCodexTurnInput = {
  threadId: string;
  content: MessageContent;
  idempotencyKey: string;
};

export type CodexTurnResult = {
  threadId: string;
  turnId: string;
  finalText: string;
  mediaReferences: string[];
};

export type CodexTurnHandle = {
  threadId: string;
  turnId: string;
  acceptedAt: string;
  completion: Promise<CodexTurnResult>;
};

export type CodexTurnStatus =
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "not_found";

export type CodexControlState = {
  model: string | null;
  reasoningEffort: string | null;
  quotaSummary: string | null;
};

export interface CodexPort {
  health(): Promise<CodexHealth>;
  listThreads(input: ListThreadsInput): Promise<CodexThread[]>;
  createThread(input: CreateThreadInput): Promise<CodexThread>;
  renameThread(threadId: string, title: string): Promise<void>;
  forkThread(threadId: string): Promise<CodexThread>;
  startTurn(input: StartCodexTurnInput): Promise<CodexTurnHandle>;
  getTurnStatus(threadId: string, turnId: string): Promise<CodexTurnStatus>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  getControlState(): Promise<CodexControlState>;
  switchModel(model: string): Promise<CodexControlState>;
}
