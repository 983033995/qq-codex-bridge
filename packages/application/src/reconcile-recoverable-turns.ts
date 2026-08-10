import type { Turn } from "../../domain/src/vnext/index.js";
import { transitionTurn } from "../../domain/src/vnext/index.js";
import type {
  Clock,
  CodexPort,
  CodexTurnStatus,
  IdGenerator,
  RuntimeEventRepository,
  TurnRepository
} from "../../ports/src/vnext/index.js";

export type RecoverableTurnResolution = {
  turn: Turn;
  remoteStatus: CodexTurnStatus | "unavailable";
};

export class ReconcileRecoverableTurns {
  constructor(private readonly deps: {
    turns: TurnRepository;
    codex: CodexPort;
    events: RuntimeEventRepository;
    ids: IdGenerator;
    clock: Clock;
  }) {}

  async execute(): Promise<RecoverableTurnResolution[]> {
    const recoverable = await this.deps.turns.listRecoverable();
    const resolutions: RecoverableTurnResolution[] = [];
    for (const turn of recoverable) {
      const unknown = turn.status === "unknown"
        ? turn
        : transitionTurn(turn, "unknown", { at: this.deps.clock.now().toISOString() });
      if (turn.status !== "unknown") {
        await this.deps.turns.save(unknown);
      }
      await this.emit("turn.recovery.unknown", unknown, { previousStatus: turn.status });

      let remoteStatus: CodexTurnStatus;
      try {
        remoteStatus = await this.deps.codex.getTurnStatus(turn.threadId, turn.turnId);
      } catch (error) {
        await this.emit("turn.recovery.unresolved", unknown, {
          remoteStatus: "unavailable",
          error: errorMessage(error)
        });
        resolutions.push({ turn: unknown, remoteStatus: "unavailable" });
        continue;
      }

      if (remoteStatus === "running") {
        await this.emit("turn.recovery.unresolved", unknown, { remoteStatus });
        resolutions.push({ turn: unknown, remoteStatus });
        continue;
      }

      const resolved = resolveUnknownTurn(
        unknown,
        remoteStatus,
        this.deps.clock.now().toISOString()
      );
      await this.deps.turns.save(resolved);
      await this.emit("turn.recovery.resolved", resolved, { remoteStatus });
      resolutions.push({ turn: resolved, remoteStatus });
    }
    return resolutions;
  }

  private async emit(
    type: string,
    turn: Turn,
    details: Readonly<Record<string, unknown>>
  ): Promise<void> {
    await this.deps.events.append({
      eventId: this.deps.ids.next(),
      component: "turn-recovery",
      type,
      payloadJson: JSON.stringify({
        turnId: turn.turnId,
        threadId: turn.threadId,
        spaceId: turn.spaceId,
        status: turn.status,
        ...details
      }),
      createdAt: this.deps.clock.now().toISOString()
    });
  }
}

function resolveUnknownTurn(
  turn: Turn,
  remoteStatus: Exclude<CodexTurnStatus, "running">,
  at: string
): Turn {
  switch (remoteStatus) {
    case "completed":
      return transitionTurn(turn, "completed", { at });
    case "interrupted":
      return transitionTurn(turn, "interrupted", { at });
    case "failed":
    case "not_found":
      return transitionTurn(turn, "failed", {
        at,
        errorCode: "CODEX_TURN_RECOVERY_FAILED"
      });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
