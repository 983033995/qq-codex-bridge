import type { TurnTransport } from "../../domain/src/vnext/index.js";
import type {
  CodexPort,
  CodexRecoveryPort,
  CodexTransportTurnHandle,
  CodexTurnHandle,
  CodexTurnTransportPort,
  StartCodexTransportTurnInput
} from "../../ports/src/vnext/index.js";

export type CodexTransportCoordinatorErrorCode = "recovery_interrupt_unsupported";

export class CodexTransportCoordinatorError extends Error {
  readonly transport = "cdp-recovery" as const;
  readonly accepted = true;

  constructor(
    message: string,
    readonly code: CodexTransportCoordinatorErrorCode
  ) {
    super(message);
    this.name = "CodexTransportCoordinatorError";
  }
}

export class CodexTransportCoordinator implements CodexTurnTransportPort {
  private readonly activeTransports = new Map<string, TurnTransport>();

  constructor(private readonly deps: {
    appServer: CodexPort;
    recovery: CodexRecoveryPort;
  }) {}

  async startTurn(input: StartCodexTransportTurnInput): Promise<CodexTransportTurnHandle> {
    try {
      const handle = await this.deps.appServer.startTurn(input);
      return this.track(handle, "app-server");
    } catch (error) {
      if (!isExplicitPreAcceptanceFailure(error)) {
        throw error;
      }
      const handle = await this.deps.recovery.startRecoveryTurn({
        threadId: input.threadId,
        threadTitle: input.threadTitle,
        content: input.content,
        idempotencyKey: input.idempotencyKey
      });
      return this.track(handle, "cdp-recovery");
    }
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const transport = this.activeTransports.get(turnKey(threadId, turnId));
    if (transport === "cdp-recovery") {
      throw new CodexTransportCoordinatorError(
        "CDP Recovery does not support precise Turn interruption",
        "recovery_interrupt_unsupported"
      );
    }
    await this.deps.appServer.interruptTurn(threadId, turnId);
  }

  private track(handle: CodexTurnHandle, transport: TurnTransport): CodexTransportTurnHandle {
    const key = turnKey(handle.threadId, handle.turnId);
    this.activeTransports.set(key, transport);
    const completion = handle.completion.then(
      (result) => {
        this.activeTransports.delete(key);
        return result;
      },
      (error) => {
        this.activeTransports.delete(key);
        throw error;
      }
    );
    void completion.catch(() => undefined);
    return { ...handle, transport, completion };
  }
}

export function isExplicitPreAcceptanceFailure(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "accepted" in error
    && (error as { accepted?: unknown }).accepted === false
  );
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}
