import type {
  CodexThread,
  ConversationSpace,
  ConversationSpaceId,
  ThreadBinding,
  ThreadBindingMode
} from "../../domain/src/vnext/index.js";
import { VNextDomainError } from "../../domain/src/vnext/index.js";
import type {
  Clock,
  CodexPort,
  ConversationSpaceRepository,
  IdGenerator,
  ThreadBindingRepository
} from "../../ports/src/vnext/index.js";

export class BindConversationSpace {
  constructor(private readonly deps: {
    spaces: ConversationSpaceRepository;
    bindings: ThreadBindingRepository;
    codex: CodexPort;
    ids: IdGenerator;
    clock: Clock;
  }) {}

  async execute(input: {
    spaceId: ConversationSpaceId;
    thread?: CodexThread;
    title?: string;
    mode?: ThreadBindingMode;
    replaceActive?: boolean;
  }): Promise<ThreadBinding> {
    const space = await this.deps.spaces.get(input.spaceId);
    if (!space) {
      throw new Error(`Conversation space not found: ${input.spaceId}`);
    }

    const active = await this.deps.bindings.getActiveBySpace(input.spaceId);
    const createRequested = !input.thread
      && (input.replaceActive === true || normalizedTitle(input.title) !== null);
    if (active && !input.thread && !createRequested) {
      return active;
    }
    if (
      active
      && input.thread
      && active.threadId === input.thread.threadId
      && active.mode === (input.mode ?? "exclusive")
    ) {
      return active;
    }
    if (active && !input.replaceActive) {
      throw new VNextDomainError(
        "BINDING_CONFLICT",
        `Conversation space '${input.spaceId}' already has an active binding`,
        { conflictingBindingId: active.bindingId }
      );
    }

    const thread = input.thread ?? await this.deps.codex.createThread({
      title: normalizedTitle(input.title) ?? defaultThreadTitle(space)
    });
    const now = this.deps.clock.now().toISOString();
    const binding: ThreadBinding = {
      bindingId: this.deps.ids.next(),
      spaceId: input.spaceId,
      threadId: thread.threadId,
      threadTitle: thread.title,
      mode: input.mode ?? "exclusive",
      status: "active",
      createdAt: now,
      updatedAt: now
    };

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
}

function defaultThreadTitle(space: ConversationSpace): string {
  const channelName = {
    weixin: "微信",
    feishu: "飞书",
    qq: "QQ"
  }[space.channel];
  return `${channelName} · ${space.displayName}`;
}

function normalizedTitle(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}
