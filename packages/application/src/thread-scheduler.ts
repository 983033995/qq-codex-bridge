import type { ConversationSpaceId } from "../../domain/src/vnext/index.js";
import { VNextDomainError } from "../../domain/src/vnext/index.js";
import type {
  Clock,
  IdGenerator,
  RuntimeEventRepository
} from "../../ports/src/vnext/index.js";

export type ThreadSchedulerTaskState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type ScheduleThreadTaskInput<T> = {
  taskId: string;
  spaceId: ConversationSpaceId;
  threadId: string;
  receivedSequence: number;
  work(): Promise<T>;
  interrupt?(): Promise<void>;
};

export type ScheduledThreadTask<T> = {
  taskId: string;
  completion: Promise<T>;
  cancel(): Promise<boolean>;
  interrupt(): Promise<boolean>;
};

export type ThreadSchedulerSnapshot = {
  running: number;
  queued: number;
  tasks: Array<{
    taskId: string;
    spaceId: ConversationSpaceId;
    threadId: string;
    receivedSequence: number;
    state: ThreadSchedulerTaskState;
  }>;
};

type InternalTask = {
  input: ScheduleThreadTaskInput<unknown>;
  state: ThreadSchedulerTaskState;
  interruptRequested: boolean;
  resolve(value: unknown): void;
  reject(error: unknown): void;
};

export class ThreadScheduler {
  private readonly maxParallel: number;
  private readonly maxQueuedPerThread: number;
  private readonly maxQueuedGlobal: number;
  private readonly tasks = new Map<string, InternalTask>();
  private readonly threadQueues = new Map<string, InternalTask[]>();
  private readonly globalQueue: InternalTask[] = [];
  private readonly runningThreads = new Set<string>();
  private readonly runningSpaces = new Set<ConversationSpaceId>();
  private readonly lastSequenceBySpace = new Map<ConversationSpaceId, number>();
  private runningCount = 0;
  private queuedCount = 0;
  private eventTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    events: RuntimeEventRepository;
    ids: IdGenerator;
    clock: Clock;
    maxParallel?: number;
    maxQueuedPerThread?: number;
    maxQueuedGlobal?: number;
  }) {
    this.maxParallel = positiveInteger(options.maxParallel ?? 3, "maxParallel");
    this.maxQueuedPerThread = positiveInteger(
      options.maxQueuedPerThread ?? 10,
      "maxQueuedPerThread"
    );
    this.maxQueuedGlobal = positiveInteger(
      options.maxQueuedGlobal ?? 60,
      "maxQueuedGlobal"
    );
  }

  async enqueue<T>(input: ScheduleThreadTaskInput<T>): Promise<ScheduledThreadTask<T>> {
    const normalized = this.validateInput(input);
    const threadQueue = this.threadQueues.get(normalized.threadId) ?? [];
    if (threadQueue.length >= this.maxQueuedPerThread) {
      throw queueFull("thread", normalized.threadId, this.maxQueuedPerThread);
    }
    if (this.queuedCount >= this.maxQueuedGlobal) {
      throw queueFull("global", null, this.maxQueuedGlobal);
    }

    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    void completion.catch(() => undefined);
    const task: InternalTask = {
      input: normalized as ScheduleThreadTaskInput<unknown>,
      state: "queued",
      interruptRequested: false,
      resolve: (value) => resolve(value as T),
      reject
    };
    this.tasks.set(normalized.taskId, task);
    threadQueue.push(task);
    this.threadQueues.set(normalized.threadId, threadQueue);
    this.globalQueue.push(task);
    this.queuedCount += 1;
    this.lastSequenceBySpace.set(normalized.spaceId, normalized.receivedSequence);

    try {
      await this.emit(task, "turn.queue.queued");
    } catch (error) {
      this.removeQueuedTask(task);
      this.tasks.delete(normalized.taskId);
      if (this.lastSequenceBySpace.get(normalized.spaceId) === normalized.receivedSequence) {
        this.lastSequenceBySpace.delete(normalized.spaceId);
      }
      reject(error);
      throw error;
    }
    this.drain();

    return {
      taskId: normalized.taskId,
      completion,
      cancel: () => this.cancel(normalized.taskId),
      interrupt: () => this.interrupt(normalized.taskId)
    };
  }

  async cancel(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || task.state !== "queued") {
      return false;
    }
    this.removeQueuedTask(task);
    task.state = "cancelled";
    this.tasks.delete(taskId);
    await this.emit(task, "turn.queue.cancelled");
    task.reject(new VNextDomainError(
      "CODEX_TURN_CANCELLED",
      `Queued turn task '${taskId}' was cancelled`
    ));
    this.drain();
    return true;
  }

  async interrupt(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return false;
    }
    if (task.state === "queued") {
      return this.cancel(taskId);
    }
    if (task.state !== "running") {
      return false;
    }
    if (task.interruptRequested) {
      return true;
    }
    if (!task.input.interrupt) {
      throw new VNextDomainError(
        "CODEX_TURN_BUSY",
        `Running turn task '${taskId}' does not support interruption`
      );
    }
    task.interruptRequested = true;
    try {
      await task.input.interrupt();
    } catch (error) {
      task.interruptRequested = false;
      throw error;
    }
    return true;
  }

  async interruptThread(threadId: string): Promise<boolean> {
    const task = [...this.tasks.values()].find(
      (candidate) => candidate.input.threadId === threadId && candidate.state === "running"
    );
    return task ? this.interrupt(task.input.taskId) : false;
  }

  snapshot(): ThreadSchedulerSnapshot {
    return {
      running: this.runningCount,
      queued: this.queuedCount,
      tasks: [...this.tasks.values()].map((task) => ({
        taskId: task.input.taskId,
        spaceId: task.input.spaceId,
        threadId: task.input.threadId,
        receivedSequence: task.input.receivedSequence,
        state: task.state
      }))
    };
  }

  private validateInput<T>(input: ScheduleThreadTaskInput<T>): ScheduleThreadTaskInput<T> {
    const taskId = required(input.taskId, "taskId");
    const threadId = required(input.threadId, "threadId");
    if (!Number.isSafeInteger(input.receivedSequence) || input.receivedSequence < 0) {
      throw new VNextDomainError(
        "MESSAGE_SEQUENCE_CONFLICT",
        "receivedSequence must be a non-negative safe integer"
      );
    }
    if (this.tasks.has(taskId)) {
      throw new VNextDomainError(
        "MESSAGE_SEQUENCE_CONFLICT",
        `Turn task '${taskId}' is already queued or running`
      );
    }
    const lastSequence = this.lastSequenceBySpace.get(input.spaceId);
    if (lastSequence !== undefined && input.receivedSequence <= lastSequence) {
      throw new VNextDomainError(
        "MESSAGE_SEQUENCE_CONFLICT",
        `Inbound sequence ${input.receivedSequence} is not newer than ${lastSequence}`,
        { spaceId: input.spaceId, receivedSequence: input.receivedSequence, lastSequence }
      );
    }
    return { ...input, taskId, threadId };
  }

  private drain(): void {
    while (this.runningCount < this.maxParallel) {
      const task = this.globalQueue.find(
        (candidate) => candidate.state === "queued"
          && !this.runningThreads.has(candidate.input.threadId)
          && !this.runningSpaces.has(candidate.input.spaceId)
          && this.threadQueues.get(candidate.input.threadId)?.[0] === candidate
      );
      if (!task) {
        return;
      }
      this.removeQueuedTask(task);
      task.state = "running";
      this.runningCount += 1;
      this.runningThreads.add(task.input.threadId);
      this.runningSpaces.add(task.input.spaceId);
      void this.executeTask(task);
    }
  }

  private async executeTask(task: InternalTask): Promise<void> {
    try {
      await this.emit(task, "turn.queue.started");
      const result = await task.input.work();
      if (task.interruptRequested) {
        throw new VNextDomainError(
          "CODEX_TURN_CANCELLED",
          `Running turn task '${task.input.taskId}' was interrupted`
        );
      }
      task.state = "completed";
      await this.emit(task, "turn.queue.completed");
      task.resolve(result);
    } catch (error) {
      task.state = task.interruptRequested ? "interrupted" : "failed";
      await this.emit(
        task,
        task.state === "interrupted" ? "turn.queue.interrupted" : "turn.queue.failed"
      ).catch(() => undefined);
      task.reject(error);
    } finally {
      this.tasks.delete(task.input.taskId);
      this.runningCount -= 1;
      this.runningThreads.delete(task.input.threadId);
      this.runningSpaces.delete(task.input.spaceId);
      this.drain();
    }
  }

  private removeQueuedTask(task: InternalTask): void {
    const globalIndex = this.globalQueue.indexOf(task);
    if (globalIndex >= 0) {
      this.globalQueue.splice(globalIndex, 1);
      this.queuedCount -= 1;
    }
    const threadQueue = this.threadQueues.get(task.input.threadId);
    if (!threadQueue) {
      return;
    }
    const threadIndex = threadQueue.indexOf(task);
    if (threadIndex >= 0) {
      threadQueue.splice(threadIndex, 1);
    }
    if (threadQueue.length === 0) {
      this.threadQueues.delete(task.input.threadId);
    }
  }

  private emit(task: InternalTask, type: string): Promise<void> {
    const createdAt = this.options.clock.now().toISOString();
    const write = this.eventTail.then(() => this.options.events.append({
      eventId: this.options.ids.next(),
      component: "turn-scheduler",
      type,
      payloadJson: JSON.stringify({
        taskId: task.input.taskId,
        spaceId: task.input.spaceId,
        threadId: task.input.threadId,
        receivedSequence: task.input.receivedSequence,
        state: task.state,
        queued: this.queuedCount,
        running: this.runningCount
      }),
      createdAt
    }));
    this.eventTail = write.catch(() => undefined);
    return write;
  }
}

function queueFull(scope: "thread" | "global", threadId: string | null, limit: number) {
  return new VNextDomainError(
    "CODEX_TURN_QUEUE_FULL",
    `${scope === "thread" ? `Thread '${threadId}'` : "Global turn"} queue is full`,
    { scope, threadId, limit }
  );
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} cannot be empty`);
  }
  return normalized;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}
