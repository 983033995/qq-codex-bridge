import type { MessageContent } from "../../domain/src/vnext/index.js";
import { VNextDomainError } from "../../domain/src/vnext/index.js";
import type {
  Clock,
  IdGenerator,
  PushJobRecord,
  PushRepository
} from "../../ports/src/vnext/index.js";

export class EnqueuePush {
  constructor(private readonly deps: {
    pushes: PushRepository;
    ids: IdGenerator;
    clock: Clock;
  }) {}

  async execute(input: {
    targetAlias: string;
    idempotencyKey: string;
    content: MessageContent;
  }): Promise<{ job: PushJobRecord; duplicate: boolean }> {
    const targetAlias = requiredValue("targetAlias", input.targetAlias);
    const idempotencyKey = requiredValue("idempotencyKey", input.idempotencyKey);
    const target = await this.deps.pushes.getTarget(targetAlias);
    if (!target || !target.enabled) {
      throw new VNextDomainError(
        "CHANNEL_DELIVERY_FAILED",
        target
          ? `Push target '${targetAlias}' is disabled`
          : `Push target '${targetAlias}' was not found`,
        { targetAlias }
      );
    }

    const now = this.deps.clock.now().toISOString();
    return this.deps.pushes.enqueue({
      pushId: this.deps.ids.next(),
      idempotencyKey,
      targetAlias,
      status: "queued",
      contentJson: JSON.stringify({ message: input.content }),
      attemptCount: 0,
      nextAttemptAt: null,
      createdAt: now,
      updatedAt: now
    });
  }
}

function requiredValue(field: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} cannot be empty`);
  }
  return normalized;
}
