import type {
  CodexThread,
  ConversationSpace,
  ConversationSpaceId,
  ThreadBinding,
  ThreadBindingMode
} from "../../domain/src/vnext/index.js";
import { assertBindingCanActivate, VNextDomainError } from "../../domain/src/vnext/index.js";
import type {
  Clock,
  CodexPort,
  ConversationSpaceRepository,
  IdGenerator,
  ThreadBindingRepository
} from "../../ports/src/vnext/index.js";

export type ThreadCoordinatorDependencies = {
  spaces: ConversationSpaceRepository;
  bindings: ThreadBindingRepository;
  codex: CodexPort;
  ids: IdGenerator;
  clock: Clock;
  threadListLimit?: number;
};

export class ThreadCoordinator {
  constructor(private readonly deps: ThreadCoordinatorDependencies) {}

  async getActiveBinding(spaceId: ConversationSpaceId): Promise<ThreadBinding | null> {
    await this.requireSpace(spaceId);
    return this.deps.bindings.getActiveBySpace(spaceId);
  }

  async ensureDefaultBinding(spaceId: ConversationSpaceId): Promise<ThreadBinding> {
    const space = await this.requireSpace(spaceId);
    const active = await this.deps.bindings.getActiveBySpace(spaceId);
    if (!active) {
      return this.createAndBind({ spaceId, title: defaultThreadTitle(space) });
    }
    const thread = await this.findThread(active.threadId);
    if (!thread) {
      return this.recoverMissingThread(space, active);
    }
    return this.refreshCachedTitle(active, thread.title);
  }

  async bindThread(input: {
    spaceId: ConversationSpaceId;
    thread: CodexThread;
    mode?: ThreadBindingMode;
    replaceActive?: boolean;
  }): Promise<ThreadBinding> {
    await this.requireSpace(input.spaceId);
    requireThread(input.thread);
    const mode = input.mode ?? "exclusive";
    const active = await this.deps.bindings.getActiveBySpace(input.spaceId);
    if (active && active.threadId === input.thread.threadId && active.mode === mode) {
      return this.refreshCachedTitle(active, input.thread.title);
    }
    if (active && !input.replaceActive) {
      throw bindingConflict(input.spaceId, active.bindingId);
    }

    const now = this.deps.clock.now().toISOString();
    const binding: ThreadBinding = {
      bindingId: this.deps.ids.next(),
      spaceId: input.spaceId,
      threadId: input.thread.threadId,
      threadTitle: input.thread.title,
      mode,
      status: "active",
      createdAt: now,
      updatedAt: now
    };
    const targetBindings = await this.deps.bindings.listActiveByThread(binding.threadId);
    assertBindingCanActivate(
      binding,
      active
        ? targetBindings.filter((candidate) => candidate.bindingId !== active.bindingId)
        : targetBindings
    );

    if (!active) {
      await this.deps.bindings.save(binding);
      return binding;
    }

    await this.deps.bindings.detach(active.bindingId, now);
    try {
      await this.deps.bindings.save(binding);
      return binding;
    } catch (error) {
      try {
        await this.deps.bindings.save({ ...active, status: "active", updatedAt: now });
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Binding replacement failed and the previous binding could not be restored"
        );
      }
      throw error;
    }
  }

  async switchToThread(input: {
    spaceId: ConversationSpaceId;
    threadId: string;
    mode?: ThreadBindingMode;
  }): Promise<ThreadBinding> {
    const threadId = requireValue(input.threadId, "threadId");
    const thread = await this.findThread(threadId);
    if (!thread) {
      throw threadNotFound(threadId);
    }
    return this.bindThread({
      spaceId: input.spaceId,
      thread,
      mode: input.mode,
      replaceActive: true
    });
  }

  async createAndBind(input: {
    spaceId: ConversationSpaceId;
    title?: string;
    cwd?: string;
    mode?: ThreadBindingMode;
    replaceActive?: boolean;
  }): Promise<ThreadBinding> {
    const space = await this.requireSpace(input.spaceId);
    const active = await this.deps.bindings.getActiveBySpace(input.spaceId);
    if (active && !input.replaceActive) {
      throw bindingConflict(input.spaceId, active.bindingId);
    }
    const thread = await this.deps.codex.createThread({
      title: normalizeTitle(input.title) ?? defaultThreadTitle(space),
      cwd: input.cwd
    });
    return this.bindThread({
      spaceId: input.spaceId,
      thread,
      mode: input.mode,
      replaceActive: input.replaceActive
    });
  }

  async renameBoundThread(spaceId: ConversationSpaceId, title: string): Promise<ThreadBinding> {
    const normalizedTitle = requireValue(title, "title");
    const binding = await this.ensureDefaultBinding(spaceId);
    try {
      await this.deps.codex.renameThread(binding.threadId, normalizedTitle);
    } catch (error) {
      if (isThreadNotFoundError(error)) {
        return this.recoverMissingThread(await this.requireSpace(spaceId), binding, normalizedTitle);
      }
      throw error;
    }
    return this.refreshCachedTitle(binding, normalizedTitle);
  }

  async forkBoundThread(input: {
    spaceId: ConversationSpaceId;
    title?: string;
    mode?: ThreadBindingMode;
  }): Promise<ThreadBinding> {
    const binding = await this.ensureDefaultBinding(input.spaceId);
    let forked: CodexThread;
    try {
      forked = await this.deps.codex.forkThread(binding.threadId);
    } catch (error) {
      if (isThreadNotFoundError(error)) {
        return this.recoverMissingThread(
          await this.requireSpace(input.spaceId),
          binding,
          normalizeTitle(input.title) ?? binding.threadTitle,
          input.mode
        );
      }
      throw error;
    }
    const title = normalizeTitle(input.title);
    if (title) {
      await this.deps.codex.renameThread(forked.threadId, title);
      forked.title = title;
    }
    return this.bindThread({
      spaceId: input.spaceId,
      thread: forked,
      mode: input.mode,
      replaceActive: true
    });
  }

  async unbind(spaceId: ConversationSpaceId): Promise<boolean> {
    await this.requireSpace(spaceId);
    const active = await this.deps.bindings.getActiveBySpace(spaceId);
    if (!active) {
      return false;
    }
    return this.deps.bindings.detach(active.bindingId, this.deps.clock.now().toISOString());
  }

  private async recoverMissingThread(
    space: ConversationSpace,
    missing: ThreadBinding,
    title = missing.threadTitle || defaultThreadTitle(space),
    mode = missing.mode
  ): Promise<ThreadBinding> {
    const now = this.deps.clock.now().toISOString();
    await this.deps.bindings.save({
      ...missing,
      status: "broken",
      updatedAt: now
    });
    return this.createAndBind({
      spaceId: space.spaceId,
      title,
      mode,
      replaceActive: false
    });
  }

  private async refreshCachedTitle(
    binding: ThreadBinding,
    threadTitle: string
  ): Promise<ThreadBinding> {
    if (binding.threadTitle === threadTitle) {
      return binding;
    }
    const updated = {
      ...binding,
      threadTitle,
      updatedAt: this.deps.clock.now().toISOString()
    };
    await this.deps.bindings.save(updated);
    return updated;
  }

  private async findThread(threadId: string): Promise<CodexThread | null> {
    const threads = await this.deps.codex.listThreads({
      limit: this.deps.threadListLimit ?? 200
    });
    return threads.find((thread) => thread.threadId === threadId) ?? null;
  }

  private async requireSpace(spaceId: ConversationSpaceId): Promise<ConversationSpace> {
    const space = await this.deps.spaces.get(spaceId);
    if (!space) {
      throw new Error(`Conversation space not found: ${spaceId}`);
    }
    return space;
  }
}

function defaultThreadTitle(space: ConversationSpace): string {
  const channelName = {
    weixin: "微信",
    feishu: "飞书",
    qq: "QQ"
  }[space.channel];
  return `${channelName} · ${space.displayName}`;
}

function normalizeTitle(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

function requireValue(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function requireThread(thread: CodexThread): void {
  requireValue(thread.threadId, "threadId");
  requireValue(thread.title, "thread title");
}

function bindingConflict(spaceId: ConversationSpaceId, bindingId: string): VNextDomainError {
  return new VNextDomainError(
    "BINDING_CONFLICT",
    `Conversation space '${spaceId}' already has an active binding`,
    { conflictingBindingId: bindingId }
  );
}

function threadNotFound(threadId: string): VNextDomainError {
  return new VNextDomainError(
    "CODEX_THREAD_NOT_FOUND",
    `Codex thread '${threadId}' was not found`,
    { threadId }
  );
}

function isThreadNotFoundError(error: unknown): boolean {
  return (
    error instanceof VNextDomainError && error.code === "CODEX_THREAD_NOT_FOUND"
  ) || (
    error instanceof Error
    && (
      ("code" in error && error.code === "thread_not_found")
      || /(?:thread.*not found|unknown.*thread)/i.test(error.message)
    )
  );
}
