import type {
  InboundEnvelope,
  StableErrorCode,
  ThreadBinding,
  Turn,
  TurnTransport
} from "../../domain/src/vnext/index.js";
import { VNextDomainError } from "../../domain/src/vnext/index.js";
import type {
  Clock,
  CodexTransportTurnHandle,
  CodexTurnHandle,
  CodexTurnResult,
  CodexTurnTransportPort,
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
    codex: CodexTurnTransportPort;
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
    let acceptedHandle: AcceptedTurnHandle | null = null;
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
    onAccepted: (handle: AcceptedTurnHandle) => Promise<void>,
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

    let handle: AcceptedTurnHandle;
    try {
      handle = await this.deps.codex.startTurn({
        threadId: binding.threadId,
        threadTitle: binding.threadTitle,
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
        transport: errorTransport(error),
        errorCode: errorCode(error),
        queuedAt: failedAt,
        startedAt: failedAt,
        completedAt: failedAt
      });
      throw error;
    }

    const transport = handleTransport(handle);
    const running: Turn = {
      turnId: handle.turnId,
      threadId: binding.threadId,
      spaceId: message.spaceId,
      inboundMessageId: message.messageId,
      status: "running",
      transport,
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
    handle: AcceptedTurnHandle
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

type AcceptedTurnHandle = CodexTurnHandle | CodexTransportTurnHandle;

function handleTransport(handle: AcceptedTurnHandle): TurnTransport {
  return "transport" in handle ? handle.transport : "app-server";
}

function errorTransport(error: unknown): TurnTransport {
  return error
    && typeof error === "object"
    && "transport" in error
    && (error as { transport?: unknown }).transport === "cdp-recovery"
    ? "cdp-recovery"
    : "app-server";
}

function errorCode(error: unknown): StableErrorCode {
  return error instanceof VNextDomainError ? error.code : "CODEX_UNAVAILABLE";
}
