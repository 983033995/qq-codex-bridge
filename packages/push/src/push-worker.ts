import { randomUUID } from "node:crypto";
import type { PushRepositoryPort, PushTargetRegistryPort } from "../../ports/src/push.js";
import { PushMediaGuard } from "./media-guard.js";
import type { PushChannelRegistry } from "./channel-registry.js";

const RETRY_DELAYS_MS = [5_000, 30_000, 120_000] as const;

export class PushWorker {
  private readonly workerId: string;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: {
    repository: PushRepositoryPort;
    targets: PushTargetRegistryPort;
    channels: PushChannelRegistry;
    mediaGuard: PushMediaGuard;
    pollIntervalMs?: number;
    staleSendingAfterMs?: number;
    now?: () => number;
    jitter?: (baseMs: number) => number;
    workerId?: string;
  }) {
    this.workerId = deps.workerId ?? randomUUID();
  }

  async start(): Promise<void> {
    await this.recoverStale();
    this.timer = setInterval(() => void this.tick(), this.deps.pollIntervalMs ?? 1_000);
    this.timer.unref?.();
    await this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const now = this.nowIso();
      const job = await this.deps.repository.claimNext(this.workerId, now);
      if (!job) {
        return;
      }
      const target = await this.deps.targets.getTarget(job.targetAlias);
      const egress = target?.enabled
        ? this.deps.channels.resolve(target.channel, target.accountKey)
        : null;
      if (!target || !egress) {
        await this.fail(job.pushId, job.attemptCount, false, "channel_unsupported", "push channel is unavailable");
        return;
      }
      let mediaPaths: string[];
      try {
        mediaPaths = job.payload.message.media.map((media) => this.deps.mediaGuard.resolve(media.path));
      } catch (error) {
        await this.fail(job.pushId, job.attemptCount, false, "media_sandbox_violation", error instanceof Error ? error.message : String(error));
        return;
      }
      try {
        const result = await egress.send({
          pushId: job.pushId,
          target,
          payload: job.payload,
          resolvedMediaPaths: mediaPaths
        });
        if (result.ok) {
          await this.deps.repository.markDelivered({
            pushId: job.pushId,
            workerId: this.workerId,
            providerMessageId: result.providerMessageId,
            now: this.nowIso()
          });
          return;
        }
        await this.fail(job.pushId, job.attemptCount, result.retryable, result.code, result.message);
      } catch (error) {
        await this.fail(job.pushId, job.attemptCount, true, "temporary_failure", error instanceof Error ? error.message : String(error));
      }
    } finally {
      this.running = false;
    }
  }

  private async fail(
    pushId: string,
    attemptCount: number,
    retryable: boolean,
    code: "channel_unsupported" | "media_sandbox_violation" | "rate_limited" | "temporary_failure" | "permanent_failure",
    error: string
  ): Promise<void> {
    const retryIndex = attemptCount - 1;
    const shouldRetry = retryable && retryIndex < RETRY_DELAYS_MS.length;
    const baseDelay = RETRY_DELAYS_MS[retryIndex];
    const delay = shouldRetry && baseDelay !== undefined
      ? baseDelay + (this.deps.jitter?.(baseDelay) ?? Math.floor(Math.random() * baseDelay * 0.2))
      : 0;
    await this.deps.repository.markFailedAttempt({
      pushId,
      workerId: this.workerId,
      code,
      error,
      nextAttemptAt: shouldRetry ? new Date(this.nowMs() + delay).toISOString() : null,
      now: this.nowIso()
    });
  }

  private async recoverStale(): Promise<void> {
    const now = this.nowMs();
    await this.deps.repository.recoverStaleSending(
      new Date(now - (this.deps.staleSendingAfterMs ?? 300_000)).toISOString(),
      new Date(now).toISOString()
    );
  }

  private nowMs(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }
}
