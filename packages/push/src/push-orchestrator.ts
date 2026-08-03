import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  PushJob,
  PushPayload,
  PushRepositoryPort,
  PushTargetRegistryPort
} from "../../ports/src/push.js";
import { PushMediaGuard } from "./media-guard.js";
import { PushRequestError } from "./push-error.js";
import { PushRateLimiter } from "./push-rate-limiter.js";

const pushBodySchema = z.object({
  target: z.string().min(1).max(128),
  message: z.object({
    text: z.string().max(100_000).default(""),
    format: z.enum(["plain", "markdown"]).default("plain"),
    media: z.array(z.object({
      type: z.enum(["image", "file", "audio", "video"]),
      path: z.string().min(1)
    })).max(16).default([])
  }).refine((message) => message.text.length > 0 || message.media.length > 0, {
    message: "message must contain text or media"
  }),
  metadata: z.object({
    source: z.string().max(128).optional(),
    taskId: z.string().max(256).optional(),
    priority: z.enum(["normal", "urgent"]).optional()
  }).passthrough().default({})
}).strict();

export class PushOrchestrator {
  constructor(private readonly deps: {
    repository: PushRepositoryPort;
    targets: PushTargetRegistryPort;
    mediaGuard: PushMediaGuard;
    rateLimiter: PushRateLimiter;
    now?: () => string;
    createId?: () => string;
  }) {}

  async enqueue(idempotencyKey: string, body: unknown): Promise<{
    pushId: string;
    status: "queued";
    duplicate: boolean;
  }> {
    if (!idempotencyKey.trim() || idempotencyKey.length > 256) {
      throw new PushRequestError(400, "invalid_request", "Idempotency-Key is required");
    }
    const parsed = pushBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new PushRequestError(400, "invalid_request", parsed.error.issues[0]?.message ?? "invalid request");
    }
    const target = await this.deps.targets.getTarget(parsed.data.target);
    if (!target?.enabled) {
      throw new PushRequestError(404, "unknown_target", "push target not found");
    }
    for (const media of parsed.data.message.media) {
      this.deps.mediaGuard.resolve(media.path);
    }
    this.deps.rateLimiter.consume();
    const payload = parsed.data as PushPayload;
    const result = await this.deps.repository.enqueue({
      pushId: this.deps.createId?.() ?? randomUUID(),
      idempotencyKey,
      targetAlias: target.alias,
      payload,
      now: this.deps.now?.() ?? new Date().toISOString()
    });
    return {
      pushId: result.job.pushId,
      status: "queued",
      duplicate: result.duplicate
    };
  }

  get(pushId: string): Promise<PushJob | null> {
    return this.deps.repository.get(pushId);
  }

  listTargets() {
    return this.deps.targets.listTargets();
  }
}
