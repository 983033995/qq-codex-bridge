import type { ComponentHealth, MessageContent, TurnTransport } from "../../../domain/src/vnext/index.js";
import type { CodexControlState, CodexTurnHandle, StartCodexTurnInput } from "./codex.js";

export type CodexRecoveryCapabilities = {
  selectKnownThread: true;
  submitText: true;
  collectFinalReply: true;
  controlState: true;
  createThread: false;
  renameThread: false;
  forkThread: false;
  concurrentTurns: false;
  preciseTurnEvents: false;
  media: false;
};

export type CodexRecoveryHealth = ComponentHealth & {
  capabilities: CodexRecoveryCapabilities;
};

export type StartCodexRecoveryTurnInput = {
  threadId: string;
  threadTitle: string;
  content: MessageContent;
  idempotencyKey: string;
};

export type CodexTransportTurnHandle = CodexTurnHandle & {
  transport: TurnTransport;
};

export type StartCodexTransportTurnInput = StartCodexTurnInput & {
  threadTitle: string;
};

export interface CodexRecoveryPort {
  health(): Promise<CodexRecoveryHealth>;
  startRecoveryTurn(input: StartCodexRecoveryTurnInput): Promise<CodexTurnHandle>;
  getControlState(): Promise<CodexControlState>;
}

export interface CodexTurnTransportPort {
  startTurn(
    input: StartCodexTransportTurnInput
  ): Promise<CodexTurnHandle | CodexTransportTurnHandle>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
}
