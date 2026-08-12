import type {
  CodexThread,
  ControlAction,
  ConversationSpaceId,
  ThreadBinding,
  ThreadSelector,
  Turn
} from "../../domain/src/vnext/index.js";
import { VNextDomainError } from "../../domain/src/vnext/index.js";
import type {
  Clock,
  CodexPort,
  PushRepository,
  ThreadBindingRepository,
  TurnRepository
} from "../../ports/src/vnext/index.js";
import type { BindConversationSpace } from "./bind-conversation-space.js";
import type { EnqueuePush } from "./enqueue-push.js";
import type { RunHealthCheck } from "./run-health-check.js";
import type { ThreadScheduler } from "./thread-scheduler.js";

export type ControlActionExecution =
  | {
      status: "confirmation_required";
      action: ControlAction;
      risk: "high";
      message: string;
    }
  | {
      status: "completed";
      action: ControlAction;
      message: string;
      data?: unknown;
    };

export class ExecuteControlAction {
  constructor(private readonly deps: {
    codex: CodexPort;
    bindings: ThreadBindingRepository;
    turns: TurnRepository;
    pushes: PushRepository;
    bindConversationSpace: BindConversationSpace;
    enqueuePush: Pick<EnqueuePush, "execute">;
    runHealthCheck: Pick<RunHealthCheck, "execute">;
    clock: Clock;
    scheduler?: ThreadScheduler;
    threadListLimit?: number;
  }) {}

  async execute(input: {
    spaceId: ConversationSpaceId;
    action: ControlAction;
    confirmed?: boolean;
    requestId?: string;
  }): Promise<ControlActionExecution> {
    if (isHighRisk(input.action) && input.confirmed !== true) {
      return {
        status: "confirmation_required",
        action: input.action,
        risk: "high",
        message: `Action '${input.action.type}' requires explicit confirmation`
      };
    }

    const action = input.action;
    switch (action.type) {
      case "thread.list": {
        const threads = await this.listThreads();
        return completed(action, "Threads listed", threads);
      }
      case "thread.current": {
        let binding = await this.deps.bindings.getActiveBySpace(input.spaceId);
        if (binding) {
          const current = await withTimeout(this.listThreads(), 2_000).then(
            (threads) => threads.find((thread) => thread.threadId === binding!.threadId) ?? null,
            () => null
          );
          if (current && current.title !== binding.threadTitle) {
            binding = {
              ...binding,
              threadTitle: current.title,
              updatedAt: this.deps.clock.now().toISOString()
            };
            await this.deps.bindings.save(binding);
          }
        }
        return completed(action, binding ? "Current thread resolved" : "No thread is bound", binding);
      }
      case "thread.switch": {
        const thread = resolveThread(action.target, await this.listThreads());
        const binding = await this.deps.bindConversationSpace.execute({
          spaceId: input.spaceId,
          thread,
          replaceActive: true
        });
        return completed(action, `Switched to '${thread.title}'`, binding);
      }
      case "thread.create": {
        const binding = await this.deps.bindConversationSpace.execute({
          spaceId: input.spaceId,
          title: action.title,
          replaceActive: true
        });
        return completed(action, `Created and bound '${binding.threadTitle}'`, binding);
      }
      case "thread.rename": {
        const title = requiredValue("title", action.title);
        const updated = await this.deps.bindConversationSpace.renameBoundThread(
          input.spaceId,
          title
        );
        return completed(action, `Renamed thread to '${title}'`, updated);
      }
      case "thread.fork": {
        const title = optionalValue(action.title);
        const next = await this.deps.bindConversationSpace.forkBoundThread({
          spaceId: input.spaceId,
          title: title ?? undefined
        });
        return completed(action, `Forked and bound '${next.threadTitle}'`, next);
      }
      case "turn.status": {
        const binding = await this.requireBinding(input.spaceId);
        const turns = await this.deps.turns.listActiveByThread(binding.threadId);
        return completed(action, turns.length ? "Active turns listed" : "No active turn", turns);
      }
      case "turn.interrupt": {
        const binding = await this.requireBinding(input.spaceId);
        const turns = await this.deps.turns.listActiveByThread(binding.threadId);
        const interrupted: Turn[] = [];
        const schedulerInterrupted = await this.deps.scheduler?.interruptThread(binding.threadId)
          ?? false;
        for (const turn of turns) {
          if (!schedulerInterrupted) {
            await this.deps.codex.interruptTurn(binding.threadId, turn.turnId);
            const next: Turn = {
              ...turn,
              status: "interrupted",
              completedAt: this.deps.clock.now().toISOString()
            };
            await this.deps.turns.save(next);
            interrupted.push(next);
          } else {
            interrupted.push(await this.deps.turns.get(turn.turnId) ?? turn);
          }
        }
        return completed(
          action,
          schedulerInterrupted || interrupted.length ? "Active turn interrupted" : "No active turn",
          interrupted
        );
      }
      case "model.current":
        return completed(action, "Current model resolved", await this.deps.codex.getControlState());
      case "model.switch": {
        const model = requiredValue("model", action.model);
        return completed(action, `Switched model to '${model}'`, await this.deps.codex.switchModel(model));
      }
      case "quota.read":
        return completed(action, "Quota resolved", await this.deps.codex.getControlState());
      case "push.targets":
        return completed(action, "Push targets listed", await this.deps.pushes.listTargets());
      case "push.send": {
        const requestId = requiredValue("requestId", input.requestId ?? "");
        const content = requiredValue("push content", action.content);
        const result = await this.deps.enqueuePush.execute({
          targetAlias: action.target,
          idempotencyKey: `control:${input.spaceId}:${requestId}`,
          content: { text: content, mentions: [], attachments: [] }
        });
        return completed(action, result.duplicate ? "Push was already queued" : "Push queued", result);
      }
      case "system.status":
        return completed(action, "System health checked", await this.deps.runHealthCheck.execute());
      case "help":
        return completed(action, "Supported actions listed", [...supportedActionTypes]);
    }
  }

  private listThreads(): Promise<CodexThread[]> {
    return this.deps.codex.listThreads({ limit: this.deps.threadListLimit ?? 200 });
  }

  private async requireBinding(spaceId: ConversationSpaceId): Promise<ThreadBinding> {
    const binding = await this.deps.bindings.getActiveBySpace(spaceId);
    if (!binding) {
      throw new VNextDomainError(
        "CODEX_THREAD_NOT_FOUND",
        `Conversation space '${spaceId}' has no active Codex thread binding`
      );
    }
    return binding;
  }
}

const highRiskActionTypes = new Set<ControlAction["type"]>([
  "turn.interrupt",
  "model.switch",
  "push.send"
]);

const supportedActionTypes: readonly ControlAction["type"][] = [
  "thread.list",
  "thread.current",
  "thread.switch",
  "thread.create",
  "thread.rename",
  "thread.fork",
  "turn.status",
  "turn.interrupt",
  "model.current",
  "model.switch",
  "quota.read",
  "push.targets",
  "push.send",
  "system.status",
  "help"
];

function isHighRisk(action: ControlAction): boolean {
  return highRiskActionTypes.has(action.type);
}

function resolveThread(selector: ThreadSelector, threads: readonly CodexThread[]): CodexThread {
  if (selector.kind === "id") {
    const thread = threads.find((candidate) => candidate.threadId === selector.threadId);
    if (thread) return thread;
  } else if (selector.kind === "index") {
    if (Number.isInteger(selector.index) && selector.index >= 1) {
      const thread = threads[selector.index - 1];
      if (thread) return thread;
    }
  } else {
    const title = requiredValue("thread title", selector.title).toLowerCase();
    const matches = threads.filter(
      (candidate) => candidate.title.trim().toLowerCase() === title
    );
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new VNextDomainError(
        "ROUTER_AMBIGUOUS",
        `Thread title '${selector.title}' matches more than one thread`
      );
    }
  }
  throw new VNextDomainError("CODEX_THREAD_NOT_FOUND", "The selected Codex thread was not found");
}

function completed(
  action: ControlAction,
  message: string,
  data?: unknown
): ControlActionExecution {
  return {
    status: "completed",
    action,
    message,
    ...(data === undefined ? {} : { data })
  };
}

function requiredValue(field: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} cannot be empty`);
  }
  return normalized;
}

function optionalValue(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Control query timed out")), timeoutMs);
    timeout.unref();
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}
