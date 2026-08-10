import type {
  CodexThread,
  ConversationSpaceId,
  ThreadBinding,
  ThreadBindingMode
} from "../../domain/src/vnext/index.js";
import type {
  Clock,
  CodexPort,
  ConversationSpaceRepository,
  IdGenerator,
  ThreadBindingRepository
} from "../../ports/src/vnext/index.js";
import { ThreadCoordinator } from "./thread-coordinator.js";

export class BindConversationSpace {
  private readonly coordinator: ThreadCoordinator;

  constructor(deps: {
    spaces: ConversationSpaceRepository;
    bindings: ThreadBindingRepository;
    codex: CodexPort;
    ids: IdGenerator;
    clock: Clock;
  }) {
    this.coordinator = new ThreadCoordinator(deps);
  }

  async execute(input: {
    spaceId: ConversationSpaceId;
    thread?: CodexThread;
    title?: string;
    mode?: ThreadBindingMode;
    replaceActive?: boolean;
  }): Promise<ThreadBinding> {
    const active = await this.coordinator.getActiveBinding(input.spaceId);
    const createRequested = !input.thread
      && (input.replaceActive === true || normalizedTitle(input.title) !== null);
    if (active && !input.thread && !createRequested) {
      return this.coordinator.ensureDefaultBinding(input.spaceId);
    }
    if (input.thread) {
      return this.coordinator.bindThread({
        spaceId: input.spaceId,
        thread: input.thread,
        mode: input.mode,
        replaceActive: input.replaceActive
      });
    }
    return this.coordinator.createAndBind({
      spaceId: input.spaceId,
      title: input.title,
      mode: input.mode,
      replaceActive: input.replaceActive
    });
  }

  renameBoundThread(spaceId: ConversationSpaceId, title: string): Promise<ThreadBinding> {
    return this.coordinator.renameBoundThread(spaceId, title);
  }

  forkBoundThread(input: {
    spaceId: ConversationSpaceId;
    title?: string;
    mode?: ThreadBindingMode;
  }): Promise<ThreadBinding> {
    return this.coordinator.forkBoundThread(input);
  }

  unbind(spaceId: ConversationSpaceId): Promise<boolean> {
    return this.coordinator.unbind(spaceId);
  }
}

function normalizedTitle(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}
