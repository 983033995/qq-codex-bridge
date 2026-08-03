import { describe, expect, it } from "vitest";
import { SqlitePushRepository } from "../../packages/store/src/push-repo.js";
import { createSqliteDatabase } from "../../packages/store/src/sqlite.js";

const payload = {
  message: { text: "任务完成", format: "plain" as const, media: [] },
  metadata: { source: "codex" }
};

describe("push repository", () => {
  it("enqueues an idempotency key once and requires claim ownership to deliver", async () => {
    const db = createSqliteDatabase(":memory:");
    const repository = new SqlitePushRepository(db, () => "2026-08-03T10:00:00.000Z");
    await repository.saveTarget({
      alias: "daily-report",
      channel: "weixin",
      accountKey: "weixin:default",
      targetType: "group",
      providerTargetId: "wx-group-1",
      enabled: true
    });

    const [first, duplicate] = await Promise.all([
      repository.enqueue({
        pushId: "push-1",
        idempotencyKey: "same-key",
        targetAlias: "daily-report",
        payload,
        now: "2026-08-03T10:00:01.000Z"
      }),
      repository.enqueue({
        pushId: "push-2",
        idempotencyKey: "same-key",
        targetAlias: "daily-report",
        payload,
        now: "2026-08-03T10:00:01.000Z"
      })
    ]);

    expect([first.duplicate, duplicate.duplicate].sort()).toEqual([false, true]);
    expect(first.job.pushId).toBe(duplicate.job.pushId);
    const claimed = await repository.claimNext("worker-1", "2026-08-03T10:00:02.000Z");
    expect(claimed).toMatchObject({ status: "sending", attemptCount: 1 });
    await expect(repository.markDelivered({
      pushId: claimed!.pushId,
      workerId: "worker-2",
      providerMessageId: "provider-1",
      now: "2026-08-03T10:00:03.000Z"
    })).resolves.toBe(false);
    expect((await repository.get(claimed!.pushId))?.status).toBe("sending");
    await expect(repository.markDelivered({
      pushId: claimed!.pushId,
      workerId: "worker-1",
      providerMessageId: "provider-1",
      now: "2026-08-03T10:00:03.000Z"
    })).resolves.toBe(true);
    expect((await repository.get(claimed!.pushId))?.status).toBe("delivered");
  });

  it("recovers stale sending work after a restart", async () => {
    const db = createSqliteDatabase(":memory:");
    const repository = new SqlitePushRepository(db);
    db.prepare(
      `INSERT INTO push_targets VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
    ).run("target", "weixin", "weixin:default", "user", "wxid", "2026-08-03T09:00:00Z", "2026-08-03T09:00:00Z");
    await repository.enqueue({
      pushId: "push-stale",
      idempotencyKey: "stale-key",
      targetAlias: "target",
      payload,
      now: "2026-08-03T09:00:00.000Z"
    });
    await repository.claimNext("dead-worker", "2026-08-03T09:01:00.000Z");

    await expect(repository.recoverStaleSending(
      "2026-08-03T09:02:00.000Z",
      "2026-08-03T10:00:00.000Z"
    )).resolves.toBe(1);
    expect(await repository.get("push-stale")).toMatchObject({
      status: "retry_wait",
      claimedBy: null
    });
  });
});
