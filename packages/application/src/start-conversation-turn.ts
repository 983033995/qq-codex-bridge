import type {
  InboundEnvelope,
  StableErrorCode,
  ThreadBinding,
  Turn
} from "../../domain/src/vnext/index.js";
import { VNextDomainError } from "../../domain/src/vnext/index.js";
import type {
  Clock,
  CodexTurnHandle,
  CodexTurnResult,
  CodexPort,
  IdGenerator,
  ThreadBindingRepository,
  TurnRepository
} from "../../ports/src/vnext/index.js";
import { ThreadScheduler } from "./thread-scheduler.js";

export type StartConversationTurnResult = {
  binding: ThreadBinding;
  turn: Turn;
  result: CodexTurnResult;
};

export class StartConversationTurn {
  constructor(private readonly deps: {
    bindings: ThreadBindingRepository;
    turns: TurnRepository;
    codex: CodexPort;
    ids: IdGenerator;
    clock: Clock;
    scheduler: ThreadScheduler;
  }) {}

  async execute(message: InboundEnvelope): Promise<StartConversationTurnResult> {
    const binding = await this.deps.bindings.getActiveBySpace(message.spaceId);
    if (!binding) {
      throw new VNextDomainError(
        "CODEX_THREAD_NOT_FOUND",
        `Conversation space '${message.spaceId}' has no active Codex thread binding`
      );
    }
    let acceptedHandle: CodexTurnHandle | null = null;
    let interruptionRequested = false;
    const scheduled = await this.deps.scheduler.enqueue({
      taskId: message.messageId,
      spaceId: message.spaceId,
      threadId: binding.threadId,
      receivedSequence: message.receivedSequence,
      work: () => this.start(binding, message, async (handle) => {
        acceptedHandle = handle;
        if (interruptionRequested) {
          await this.interruptAccepted(binding, message, handle);
        }
      }, () => interruptionRequested),
      interrupt: async () => {
        interruptionRequested = true;
        if (acceptedHandle) {
          await this.interruptAccepted(binding, message, acceptedHandle);
        }
      }
    });
    return scheduled.completion;
  }

  private async start(
    binding: ThreadBinding,
    message: InboundEnvelope,
    onAccepted: (handle: CodexTurnHandle) => Promise<void>,
    isInterruptionRequested: () => boolean
  ): Promise<StartConversationTurnResult> {
    const active = await this.deps.turns.listActiveByThread(binding.threadId);
    if (active.length > 0) {
      throw new VNextDomainError(
        "CODEX_TURN_BUSY",
        `Codex thread '${binding.threadId}' already has an active turn`,
        { activeTurnIds: active.map((turn) => turn.turnId) }
      );
    }

    let handle: CodexTurnHandle;
    try {
      handle = await this.deps.codex.startTurn({
        threadId: binding.threadId,
        content: message.content,
        idempotencyKey: message.messageId
      });
    } catch (error) {
      const failedAt = this.deps.clock.now().toISOString();
      await this.deps.turns.save({
        turnId: this.deps.ids.next(),
        threadId: binding.threadId,
        spaceId: message.spaceId,
        inboundMessageId: message.messageId,
        status: "failed",
        transport: "app-server",
        errorCode: errorCode(error),
        queuedAt: failedAt,
        startedAt: failedAt,
        completedAt: failedAt
      });
      throw error;
    }

    const running: Turn = {
      turnId: handle.turnId,
      threadId: binding.threadId,
      spaceId: message.spaceId,
      inboundMessageId: message.messageId,
      status: "running",
      transport: "app-server",
      errorCode: null,
      queuedAt: handle.acceptedAt,
      startedAt: handle.acceptedAt,
      completedAt: null
    };
    await this.deps.turns.save(running);
    await onAccepted(handle);

    let result: CodexTurnResult;
    try {
      result = await handle.completion;
      if (result.threadId !== handle.threadId || result.turnId !== handle.turnId) {
        throw new Error("Codex turn completion identity does not match its accepted handle");
      }
    } catch (error) {
      const latest = await this.deps.turns.get(running.turnId);
      if (latest?.status === "interrupted" || isInterruptionRequested()) {
        throw error;
      }
      await this.deps.turns.save({
        ...running,
        status: "failed",
        errorCode: errorCode(error),
        completedAt: this.deps.clock.now().toISOString()
      });
      throw error;
    }

    const completed: Turn = {
      ...running,
      status: "completed",
      completedAt: this.deps.clock.now().toISOString()
    };
    await this.deps.turns.save(completed);
    return { binding, turn: completed, result };
  }

  private async interruptAccepted(
    binding: ThreadBinding,
    message: InboundEnvelope,
    handle: CodexTurnHandle
  ): Promise<void> {
    const current = await this.deps.turns.get(handle.turnId);
    if (!current || current.inboundMessageId !== message.messageId) {
      return;
    }
    if (current.status === "interrupted") {
      return;
    }
    await this.deps.codex.interruptTurn(binding.threadId, handle.turnId);
    await this.deps.turns.save({
      ...current,
      status: "interrupted",
      completedAt: this.deps.clock.now().toISOString()
    });
  }
}

function errorCode(error: unknown): StableErrorCode {
  return error instanceof VNextDomainError ? error.code : "CODEX_UNAVAILABLE";
}
