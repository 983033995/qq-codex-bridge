import type { CodexThread } from "../../domain/src/vnext/index.js";
import type {
  CodexHealth,
  CodexPort,
  CodexTurnHandle,
  CodexTurnResult
} from "../../ports/src/vnext/index.js";

export type RunCodexSmokeInput = {
  runId: string;
  cwd: string;
  completionTimeoutMs?: number;
  interruptProbe: {
    prompt: string;
    waitUntilReady(timeoutMs: number): Promise<void>;
  };
};

export type CodexSmokeTurnResult = {
  label: "A" | "B" | "C";
  marker: string;
  threadId: string;
  turnId: string;
  finalText: string;
};

export type CodexSmokeReport = {
  runId: string;
  startedAt: string;
  completedAt: string;
  health: CodexHealth;
  visibleThreadsBefore: number;
  createdThreads: CodexThread[];
  parallelTurns: CodexSmokeTurnResult[];
  interruptedTurn: {
    threadId: string;
    turnId: string;
    status: "interrupted";
    completionRejected: true;
  };
  retainedThreadIds: string[];
};

const LABELS = ["A", "B", "C"] as const;

export class RunCodexSmoke {
  constructor(
    private readonly codex: CodexPort,
    private readonly now: () => Date = () => new Date()
  ) {}

  async execute(input: RunCodexSmokeInput): Promise<CodexSmokeReport> {
    const runId = required(input.runId, "runId");
    const cwd = required(input.cwd, "cwd");
    const completionTimeoutMs = positiveInteger(
      input.completionTimeoutMs ?? 180_000,
      "completionTimeoutMs"
    );
    const startedAt = this.now().toISOString();
    const health = await this.codex.health();
    if (health.status !== "ready") {
      throw new Error(`Codex AppServer is not ready: ${health.status} ${health.message}`);
    }
    const visibleThreadsBefore = (await this.codex.listThreads({ limit: 200 })).length;
    const createdThreads = await Promise.all(LABELS.map((label) => this.codex.createThread({
      title: `vNext Smoke ${runId} ${label}`,
      cwd
    })));
    assertDistinctThreadIds(createdThreads);

    const handles = await Promise.all(createdThreads.map((thread, index) => {
      const label = LABELS[index]!;
      const marker = markerFor(runId, label);
      return this.codex.startTurn({
        threadId: thread.threadId,
        idempotencyKey: `vnext-smoke:${runId}:${label}`,
        content: {
          text: `Reply with exactly ${marker} and nothing else. Do not call tools.`,
          mentions: [],
          attachments: []
        }
      });
    }));
    assertDistinctTurnIds(handles);

    const settled = new Set<string>();
    let parallelTurns: CodexSmokeTurnResult[];
    try {
      parallelTurns = await Promise.all(handles.map(async (handle, index) => {
        const label = LABELS[index]!;
        const marker = markerFor(runId, label);
        try {
          const result = await withTimeout(
            handle.completion,
            completionTimeoutMs,
            `Codex smoke turn ${label} timed out after ${completionTimeoutMs}ms`
          );
          assertTurnIdentity(handle, result);
          if (!result.finalText.includes(marker)) {
            throw new Error(
              `Codex smoke turn ${label} reply did not contain marker ${marker}: ${result.finalText}`
            );
          }
          return {
            label,
            marker,
            threadId: result.threadId,
            turnId: result.turnId,
            finalText: result.finalText
          };
        } finally {
          settled.add(turnKey(handle));
        }
      }));
    } catch (error) {
      await this.interruptUnsettled(handles, settled);
      throw error;
    }

    const interrupted = await this.codex.startTurn({
      threadId: createdThreads[0]!.threadId,
      idempotencyKey: `vnext-smoke:${runId}:interrupt`,
      content: {
        text: `${required(input.interruptProbe.prompt, "interruptProbe.prompt")} ${[
          "Only after the probe command completes, reply with exactly",
          markerFor(runId, "INTERRUPT")
        ].join(" ")}.`,
        mentions: [],
        attachments: []
      }
    });
    const completionOutcome = interrupted.completion.then(
      (result) => ({ kind: "completed" as const, result }),
      (error: unknown) => ({ kind: "rejected" as const, error })
    );
    const readinessOutcome = input.interruptProbe.waitUntilReady(completionTimeoutMs)
      .then(() => ({ kind: "ready" as const }));
    const firstOutcome = await Promise.race([readinessOutcome, completionOutcome]);
    if (firstOutcome.kind !== "ready") {
      throw new Error(
        `Codex smoke interrupt Turn settled before its readiness probe (${firstOutcome.kind})`
      );
    }
    await this.codex.interruptTurn(interrupted.threadId, interrupted.turnId);
    const completionRejected = (await completionOutcome).kind === "rejected";
    const interruptedStatus = await this.codex.getTurnStatus(
      interrupted.threadId,
      interrupted.turnId
    );
    if (!completionRejected || interruptedStatus !== "interrupted") {
      throw new Error(
        `Codex smoke interrupt verification failed: rejected=${completionRejected} status=${interruptedStatus}`
      );
    }

    const retainedIds = new Set(
      (await this.codex.listThreads({ limit: 200 })).map((thread) => thread.threadId)
    );
    const retainedThreadIds = createdThreads
      .map((thread) => thread.threadId)
      .filter((threadId) => retainedIds.has(threadId));
    if (retainedThreadIds.length !== createdThreads.length) {
      throw new Error("One or more Codex smoke threads were not visible after verification");
    }

    return {
      runId,
      startedAt,
      completedAt: this.now().toISOString(),
      health,
      visibleThreadsBefore,
      createdThreads,
      parallelTurns,
      interruptedTurn: {
        threadId: interrupted.threadId,
        turnId: interrupted.turnId,
        status: "interrupted",
        completionRejected: true
      },
      retainedThreadIds
    };
  }

  private async interruptUnsettled(
    handles: CodexTurnHandle[],
    settled: Set<string>
  ): Promise<void> {
    await Promise.allSettled(handles
      .filter((handle) => !settled.has(turnKey(handle)))
      .map((handle) => this.codex.interruptTurn(handle.threadId, handle.turnId)));
  }
}

function assertDistinctThreadIds(threads: CodexThread[]): void {
  if (new Set(threads.map((thread) => thread.threadId)).size !== threads.length) {
    throw new Error("Codex smoke did not create three distinct threads");
  }
}

function assertDistinctTurnIds(handles: CodexTurnHandle[]): void {
  if (new Set(handles.map((handle) => turnKey(handle))).size !== handles.length) {
    throw new Error("Codex smoke did not receive distinct parallel turn handles");
  }
}

function assertTurnIdentity(handle: CodexTurnHandle, result: CodexTurnResult): void {
  if (handle.threadId !== result.threadId || handle.turnId !== result.turnId) {
    throw new Error("Codex smoke completion identity did not match its accepted handle");
  }
}

function markerFor(runId: string, label: string): string {
  return `VNEXT_SMOKE_${runId.replace(/[^A-Za-z0-9]/g, "_")}_${label}`;
}

function turnKey(handle: Pick<CodexTurnHandle, "threadId" | "turnId">): string {
  return `${handle.threadId}\u0000${handle.turnId}`;
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        timeout.unref?.();
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
