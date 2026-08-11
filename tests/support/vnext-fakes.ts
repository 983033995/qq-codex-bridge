import type {
  CodexThread,
  ConversationSpace,
  ConversationSpaceId,
  Delivery,
  InboundEnvelope,
  MessageContent,
  ThreadBinding,
  Turn
} from "../../packages/domain/src/vnext/index.js";
import { assertBindingCanActivate } from "../../packages/domain/src/vnext/index.js";
import type {
  Clock,
  CodexCapabilities,
  CodexControlState,
  CodexHealth,
  CodexPort,
  CodexTurnHandle,
  CodexTurnResult,
  CodexTurnStatus,
  ConversationSpaceRepository,
  CursorPage,
  DeliveryRepository,
  IdGenerator,
  ListThreadsInput,
  MessageLedger,
  PushJobRecord,
  PushRepository,
  PushTargetRecord,
  RoutingDecisionRecord,
  RoutingDecisionRepository,
  RuntimeEventRecord,
  RuntimeEventRepository,
  StartCodexTurnInput,
  ThreadBindingRepository,
  TurnRepository
} from "../../packages/ports/src/vnext/index.js";

export class FixedClock implements Clock {
  constructor(private value = "2026-08-10T06:00:00.000Z") {}

  now(): Date {
    return new Date(this.value);
  }

  set(value: string): void {
    this.value = value;
  }
}

export class SequenceIdGenerator implements IdGenerator {
  private nextValue = 1;

  constructor(private readonly prefix = "id") {}

  next(): string {
    return `${this.prefix}-${this.nextValue++}`;
  }
}

export class MemoryConversationSpaceRepository implements ConversationSpaceRepository {
  readonly values = new Map<ConversationSpaceId, ConversationSpace>();

  async get(spaceId: ConversationSpaceId): Promise<ConversationSpace | null> {
    return this.values.get(spaceId) ?? null;
  }

  async save(space: ConversationSpace): Promise<void> {
    this.values.set(space.spaceId, structuredClone(space));
  }

  async list(input: { limit: number; cursor?: string }): Promise<CursorPage<ConversationSpace>> {
    const values = [...this.values.values()].sort((left, right) =>
      left.spaceId.localeCompare(right.spaceId)
    );
    const start = input.cursor
      ? values.findIndex((space) => space.spaceId > input.cursor!)
      : 0;
    const items = (start < 0 ? [] : values.slice(start, start + input.limit));
    const hasMore = start >= 0 && start + input.limit < values.length;
    return {
      items: structuredClone(items),
      nextCursor: hasMore ? items.at(-1)!.spaceId : null
    };
  }
}

export class MemoryThreadBindingRepository implements ThreadBindingRepository {
  readonly values = new Map<string, ThreadBinding>();
  failNextSave: Error | null = null;

  async getActiveBySpace(spaceId: ConversationSpaceId): Promise<ThreadBinding | null> {
    return [...this.values.values()].find(
      (binding) => binding.spaceId === spaceId && binding.status === "active"
    ) ?? null;
  }

  async listActiveByThread(threadId: string): Promise<ThreadBinding[]> {
    return [...this.values.values()]
      .filter((binding) => binding.threadId === threadId && binding.status === "active")
      .sort((left, right) => left.bindingId.localeCompare(right.bindingId));
  }

  async save(binding: ThreadBinding): Promise<void> {
    if (this.failNextSave) {
      const error = this.failNextSave;
      this.failNextSave = null;
      throw error;
    }
    assertBindingCanActivate(binding, [...this.values.values()]);
    this.values.set(binding.bindingId, structuredClone(binding));
  }

  async detach(bindingId: string, updatedAt: string): Promise<boolean> {
    const binding = this.values.get(bindingId);
    if (!binding || binding.status !== "active") {
      return false;
    }
    this.values.set(bindingId, { ...binding, status: "detached", updatedAt });
    return true;
  }
}

export class MemoryMessageLedger implements MessageLedger {
  private readonly byDedupe = new Map<string, InboundEnvelope>();
  private readonly byId = new Map<string, InboundEnvelope>();

  async findByDedupeKey(dedupeKey: string): Promise<InboundEnvelope | null> {
    return this.byDedupe.get(dedupeKey) ?? null;
  }

  async appendInbound(message: InboundEnvelope, dedupeKey: string): Promise<boolean> {
    if (this.byDedupe.has(dedupeKey)) {
      return false;
    }
    if (this.byId.has(message.messageId)) {
      throw new Error(`Duplicate message id: ${message.messageId}`);
    }
    this.byDedupe.set(dedupeKey, structuredClone(message));
    this.byId.set(message.messageId, structuredClone(message));
    return true;
  }

  async listBySpace(input: {
    spaceId: ConversationSpaceId;
    limit: number;
    cursor?: string;
  }): Promise<CursorPage<InboundEnvelope>> {
    const values = [...this.byId.values()]
      .filter((message) => message.spaceId === input.spaceId)
      .sort((left, right) => left.messageId.localeCompare(right.messageId));
    const start = input.cursor
      ? values.findIndex((message) => message.messageId > input.cursor!)
      : 0;
    const items = start < 0 ? [] : values.slice(start, start + input.limit);
    return {
      items: structuredClone(items),
      nextCursor: start >= 0 && start + input.limit < values.length
        ? items.at(-1)!.messageId
        : null
    };
  }
}

export class MemoryTurnRepository implements TurnRepository {
  readonly values = new Map<string, Turn>();
  private readonly waiters: Array<{
    turnId: string;
    status: Turn["status"];
    resolve(turn: Turn): void;
  }> = [];

  async get(turnId: string): Promise<Turn | null> {
    return this.values.get(turnId) ?? null;
  }

  async save(turn: Turn): Promise<void> {
    this.values.set(turn.turnId, structuredClone(turn));
    for (const waiter of [...this.waiters]) {
      if (waiter.turnId === turn.turnId && waiter.status === turn.status) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(structuredClone(turn));
      }
    }
  }

  async listActiveByThread(threadId: string): Promise<Turn[]> {
    return [...this.values.values()].filter(
      (turn) => turn.threadId === threadId
        && ["queued", "starting", "running", "unknown"].includes(turn.status)
    );
  }

  async listRecoverable(): Promise<Turn[]> {
    return [...this.values.values()].filter(
      (turn) => ["starting", "running", "unknown"].includes(turn.status)
    );
  }

  waitForStatus(turnId: string, status: Turn["status"]): Promise<Turn> {
    const current = this.values.get(turnId);
    if (current?.status === status) {
      return Promise.resolve(structuredClone(current));
    }
    return new Promise((resolve) => {
      this.waiters.push({ turnId, status, resolve });
    });
  }
}

export class MemoryRoutingDecisionRepository implements RoutingDecisionRepository {
  readonly values: RoutingDecisionRecord[] = [];

  async save(record: RoutingDecisionRecord): Promise<void> {
    this.values.push(structuredClone(record));
  }

  async list(input: { limit: number; cursor?: string }): Promise<CursorPage<RoutingDecisionRecord>> {
    const start = input.cursor ? Number(input.cursor) : 0;
    const items = this.values.slice(start, start + input.limit);
    return {
      items: structuredClone(items),
      nextCursor: start + input.limit < this.values.length ? String(start + input.limit) : null
    };
  }
}

export class MemoryDeliveryRepository implements DeliveryRepository {
  readonly values = new Map<string, Delivery>();
  readonly contents = new Map<string, MessageContent>();

  async get(deliveryId: string): Promise<Delivery | null> {
    return this.values.get(deliveryId) ?? null;
  }

  async findByKey(deliveryKey: string): Promise<Delivery | null> {
    return [...this.values.values()].find((delivery) => delivery.deliveryKey === deliveryKey) ?? null;
  }

  async listRecoverable(input: { limit: number }) {
    return [...this.values.values()]
      .filter((delivery) => delivery.status === "sending" || delivery.status === "retry_wait")
      .sort((left, right) => (left.nextAttemptAt ?? left.updatedAt).localeCompare(right.nextAttemptAt ?? right.updatedAt))
      .slice(0, input.limit)
      .map((delivery) => ({
        delivery: structuredClone(delivery),
        content: structuredClone(this.contents.get(delivery.deliveryId) ?? { text: "", mentions: [], attachments: [] })
      }));
  }

  async save(delivery: Delivery, content?: MessageContent): Promise<void> {
    this.values.set(delivery.deliveryId, structuredClone(delivery));
    if (content) this.contents.set(delivery.deliveryId, structuredClone(content));
  }
}

export class MemoryPushRepository implements PushRepository {
  readonly targets = new Map<string, PushTargetRecord>();
  readonly jobs = new Map<string, PushJobRecord>();

  async getTarget(alias: string): Promise<PushTargetRecord | null> {
    return this.targets.get(alias) ?? null;
  }

  async listTargets(): Promise<PushTargetRecord[]> {
    return [...this.targets.values()]
      .filter((target) => target.enabled)
      .sort((left, right) => left.alias.localeCompare(right.alias))
      .map((target) => structuredClone(target));
  }

  async saveTarget(target: PushTargetRecord): Promise<void> {
    this.targets.set(target.alias, structuredClone(target));
  }

  async enqueue(job: PushJobRecord): Promise<{ job: PushJobRecord; duplicate: boolean }> {
    const existing = [...this.jobs.values()].find(
      (candidate) => candidate.idempotencyKey === job.idempotencyKey
    );
    if (existing) {
      return { job: structuredClone(existing), duplicate: true };
    }
    this.jobs.set(job.pushId, structuredClone(job));
    return { job: structuredClone(job), duplicate: false };
  }

  async getJob(pushId: string): Promise<PushJobRecord | null> {
    return this.jobs.get(pushId) ?? null;
  }
}

export class MemoryRuntimeEventRepository implements RuntimeEventRepository {
  readonly values: RuntimeEventRecord[] = [];

  async append(event: RuntimeEventRecord): Promise<void> {
    this.values.push(structuredClone(event));
  }

  async list(input: { limit: number; cursor?: string }): Promise<CursorPage<RuntimeEventRecord>> {
    const start = input.cursor ? Number(input.cursor) : 0;
    const items = this.values.slice(start, start + input.limit);
    return {
      items: structuredClone(items),
      nextCursor: start + input.limit < this.values.length ? String(start + input.limit) : null
    };
  }
}

type DeferredTurn = {
  input: StartCodexTurnInput;
  handle: CodexTurnHandle;
  resolve(result: CodexTurnResult): void;
  reject(error: unknown): void;
};

export class ControllableCodexPort implements CodexPort {
  readonly threads: CodexThread[] = [];
  readonly starts: DeferredTurn[] = [];
  private readonly startWaiters: Array<{ count: number; resolve(): void }> = [];
  private nextThread = 1;
  private nextTurn = 1;
  private readonly turnStatuses = new Map<string, CodexTurnStatus>();
  private control: CodexControlState = {
    model: "fake-model",
    reasoningEffort: null,
    quotaSummary: "100%"
  };

  constructor(readonly autoComplete = true) {}

  async health(): Promise<CodexHealth> {
    return {
      component: "codex",
      status: "ready",
      message: "ready",
      since: "2026-08-10T06:00:00.000Z",
      capabilities: capabilities()
    };
  }

  async listThreads(input: ListThreadsInput): Promise<CodexThread[]> {
    return structuredClone(this.threads.slice(0, input.limit));
  }

  async createThread(input: { title?: string; cwd?: string }): Promise<CodexThread> {
    const thread: CodexThread = {
      threadId: `thread-${this.nextThread++}`,
      title: input.title ?? "Untitled",
      projectName: input.cwd ?? null,
      updatedAt: "2026-08-10T06:00:00.000Z"
    };
    this.threads.unshift(thread);
    return structuredClone(thread);
  }

  async renameThread(threadId: string, title: string): Promise<void> {
    this.requireThread(threadId).title = title;
  }

  async forkThread(threadId: string): Promise<CodexThread> {
    const source = this.requireThread(threadId);
    return this.createThread({ title: `${source.title} (fork)` });
  }

  async startTurn(input: StartCodexTurnInput): Promise<CodexTurnHandle> {
    this.requireThread(input.threadId);
    const turnId = `turn-${this.nextTurn++}`;
    let resolve!: (result: CodexTurnResult) => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<CodexTurnResult>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const handle: CodexTurnHandle = {
      threadId: input.threadId,
      turnId,
      acceptedAt: "2026-08-10T06:00:00.000Z",
      completion
    };
    const deferred = { input: structuredClone(input), handle, resolve, reject };
    this.starts.push(deferred);
    this.turnStatuses.set(turnId, "running");
    this.resolveStartWaiters();
    if (this.autoComplete) {
      queueMicrotask(() => this.complete(turnId));
    }
    return handle;
  }

  async getTurnStatus(_threadId: string, turnId: string): Promise<CodexTurnStatus> {
    return this.turnStatuses.get(turnId) ?? "not_found";
  }

  async interruptTurn(_threadId: string, turnId: string): Promise<void> {
    this.turnStatuses.set(turnId, "interrupted");
    this.requireStart(turnId).reject(new Error("interrupted"));
  }

  async getControlState(): Promise<CodexControlState> {
    return structuredClone(this.control);
  }

  async switchModel(model: string): Promise<CodexControlState> {
    this.control = { ...this.control, model };
    return this.getControlState();
  }

  waitForStartCount(count: number): Promise<void> {
    if (this.starts.length >= count) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.startWaiters.push({ count, resolve });
    });
  }

  complete(turnId: string, finalText = `completed ${turnId}`, mediaReferences: string[] = []): void {
    const started = this.requireStart(turnId);
    this.turnStatuses.set(turnId, "completed");
    started.resolve({
      threadId: started.handle.threadId,
      turnId,
      finalText,
      mediaReferences
    });
  }

  fail(turnId: string, error: unknown): void {
    this.turnStatuses.set(turnId, "failed");
    this.requireStart(turnId).reject(error);
  }

  private requireThread(threadId: string): CodexThread {
    const thread = this.threads.find((candidate) => candidate.threadId === threadId);
    if (!thread) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    return thread;
  }

  private requireStart(turnId: string): DeferredTurn {
    const started = this.starts.find((candidate) => candidate.handle.turnId === turnId);
    if (!started) {
      throw new Error(`Turn not found: ${turnId}`);
    }
    return started;
  }

  private resolveStartWaiters(): void {
    for (const waiter of [...this.startWaiters]) {
      if (this.starts.length >= waiter.count) {
        this.startWaiters.splice(this.startWaiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  }
}

function capabilities(): CodexCapabilities {
  return {
    listThreads: true,
    createThread: true,
    renameThread: true,
    forkThread: true,
    concurrentThreads: true,
    media: true
  };
}
