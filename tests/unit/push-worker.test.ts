import { describe, expect, it, vi } from "vitest";
import { PushChannelRegistry } from "../../packages/push/src/channel-registry.js";
import { PushMediaGuard } from "../../packages/push/src/media-guard.js";
import { PushWorker } from "../../packages/push/src/push-worker.js";
import { SqlitePushRepository } from "../../packages/store/src/push-repo.js";
import { createSqliteDatabase } from "../../packages/store/src/sqlite.js";

describe("push worker", () => {
  it("marks delivered only after a successful egress and retries temporary failures", async () => {
    const repository = new SqlitePushRepository(createSqliteDatabase(":memory:"));
    await repository.saveTarget({
      alias: "ops",
      channel: "weixin",
      accountKey: "weixin:default",
      targetType: "group",
      providerTargetId: "group-1",
      enabled: true
    });
    await repository.enqueue({
      pushId: "push-worker",
      idempotencyKey: "worker-key",
      targetAlias: "ops",
      payload: { message: { text: "done", format: "plain", media: [] }, metadata: {} },
      now: "2026-08-03T10:00:00.000Z"
    });
    let now = Date.parse("2026-08-03T10:00:00.000Z");
    const send = vi.fn()
      .mockResolvedValueOnce({ ok: false, retryable: true, code: "temporary_failure", message: "429" })
      .mockResolvedValueOnce({ ok: true, providerMessageId: "wx-message-1" });
    const channels = new PushChannelRegistry();
    channels.register("weixin", "weixin:default", { send });
    const worker = new PushWorker({
      repository,
      targets: repository,
      channels,
      mediaGuard: new PushMediaGuard("runtime/media/push-outbox-test"),
      workerId: "worker",
      now: () => now,
      jitter: () => 0
    });

    await worker.tick();
    expect(await repository.get("push-worker")).toMatchObject({
      status: "retry_wait",
      attemptCount: 1,
      providerMessageId: null
    });
    now += 5_000;
    await worker.tick();
    expect(await repository.get("push-worker")).toMatchObject({
      status: "delivered",
      attemptCount: 2,
      providerMessageId: "wx-message-1"
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("uses 5s, 30s, and 120s backoff before the terminal fourth attempt", async () => {
    const repository = new SqlitePushRepository(createSqliteDatabase(":memory:"));
    await repository.saveTarget({
      alias: "retry-target",
      channel: "weixin",
      accountKey: "weixin:default",
      targetType: "user",
      providerTargetId: "user-1",
      enabled: true
    });
    await repository.enqueue({
      pushId: "push-retries",
      idempotencyKey: "retry-key",
      targetAlias: "retry-target",
      payload: { message: { text: "retry", format: "plain", media: [] }, metadata: {} },
      now: "2026-08-03T10:00:00.000Z"
    });
    let now = Date.parse("2026-08-03T10:00:00.000Z");
    const send = vi.fn().mockResolvedValue({
      ok: false,
      retryable: true,
      code: "temporary_failure",
      message: "unavailable"
    });
    const channels = new PushChannelRegistry();
    channels.register("weixin", "weixin:default", { send });
    const worker = new PushWorker({
      repository,
      targets: repository,
      channels,
      mediaGuard: new PushMediaGuard("runtime/media/push-outbox-test"),
      workerId: "retry-worker",
      now: () => now,
      jitter: () => 0
    });

    for (const delay of [5_000, 30_000, 120_000]) {
      await worker.tick();
      const job = await repository.get("push-retries");
      expect(job?.status).toBe("retry_wait");
      expect(Date.parse(job!.nextAttemptAt!) - now).toBe(delay);
      now += delay;
    }
    await worker.tick();
    expect(await repository.get("push-retries")).toMatchObject({
      status: "failed",
      attemptCount: 4
    });
    expect(send).toHaveBeenCalledTimes(4);
  });
});
