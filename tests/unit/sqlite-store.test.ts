import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it, afterEach } from "vitest";
import { BridgeSessionStatus } from "../../packages/domain/src/session.js";
import { buildPeerKey, buildSessionKey } from "../../packages/orchestrator/src/session-key.js";
import { createSqliteDatabase } from "../../packages/store/src/sqlite.js";
import { SqliteSessionStore } from "../../packages/store/src/session-repo.js";
import { SqliteTranscriptStore } from "../../packages/store/src/message-repo.js";

describe("sqlite store", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createTempDbPath(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "qq-codex-bridge-"));
    tempDirs.push(dir);
    return path.join(dir, "data", "bridge.sqlite");
  }

  function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;

    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    return { promise, resolve, reject };
  }

  it("persists a session that can be read back as active", async () => {
    const dbPath = createTempDbPath();
    const db = createSqliteDatabase(dbPath);
    const sessionStore = new SqliteSessionStore(db);

    const sessionKey = buildSessionKey({
      accountKey: "qqbot:default",
      peerKey: buildPeerKey({ chatType: "c2c", peerId: "abc-123" })
    });

    await sessionStore.createSession({
      sessionKey,
      accountKey: "qqbot:default",
      peerKey: "qq:c2c:abc-123",
      chatType: "c2c",
      peerId: "abc-123",
      codexThreadRef: null,
      skillContextKey: null,
      status: BridgeSessionStatus.Active,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastError: null
    });

    const session = await sessionStore.getSession(sessionKey);

    expect(session).toEqual({
      sessionKey,
      accountKey: "qqbot:default",
      peerKey: "qq:c2c:abc-123",
      chatType: "c2c",
      peerId: "abc-123",
      codexThreadRef: null,
      skillContextKey: null,
      status: BridgeSessionStatus.Active,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastError: null
    });
  });

  it("records inbound messages and prevents duplicate digests", async () => {
    const dbPath = createTempDbPath();
    const db = createSqliteDatabase(dbPath);
    const transcriptStore = new SqliteTranscriptStore(db);

    await transcriptStore.recordInbound({
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:abc-123",
      peerKey: "qq:c2c:abc-123",
      chatType: "c2c",
      senderId: "abc-123",
      text: "hello",
      receivedAt: "2026-04-08T10:00:00.000Z"
    });

    await transcriptStore.recordInbound({
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:abc-123",
      peerKey: "qq:c2c:abc-123",
      chatType: "c2c",
      senderId: "abc-123",
      text: "hello",
      receivedAt: "2026-04-08T10:00:00.000Z"
    });

    await transcriptStore.recordOutbound({
      draftId: "draft-1",
      sessionKey: "qqbot:default::qq:c2c:abc-123",
      text: "reply",
      createdAt: "2026-04-08T10:00:01.000Z"
    });

    await expect(transcriptStore.hasInbound("msg-1")).resolves.toBe(true);
    await expect(transcriptStore.hasInbound("msg-2")).resolves.toBe(false);
  });

  it("serializes overlapping work for the same session key", async () => {
    const dbPath = createTempDbPath();
    const db = createSqliteDatabase(dbPath);
    const sessionStore = new SqliteSessionStore(db);
    const sessionKey = buildSessionKey({
      accountKey: "qqbot:default",
      peerKey: buildPeerKey({ chatType: "c2c", peerId: "abc-123" })
    });

    const firstTurn = createDeferred<void>();
    const secondEntered: string[] = [];
    const firstEntered = createDeferred<void>();

    const firstWork = sessionStore.withSessionLock(sessionKey, async () => {
      firstEntered.resolve();
      await firstTurn.promise;
    });

    await firstEntered.promise;

    const secondWork = sessionStore.withSessionLock(sessionKey, async () => {
      secondEntered.push("entered");
    });

    expect(secondEntered).toEqual([]);

    firstTurn.resolve();

    await expect(firstWork).resolves.toBeUndefined();
    await expect(secondWork).resolves.toBeUndefined();
    expect(secondEntered).toEqual(["entered"]);
  });

  it("replaces a stale in-db lock left behind by a previous process", async () => {
    const dbPath = createTempDbPath();
    const db = createSqliteDatabase(dbPath);
    const sessionStore = new SqliteSessionStore(db);
    const sessionKey = buildSessionKey({
      accountKey: "qqbot:default",
      peerKey: buildPeerKey({ chatType: "c2c", peerId: "abc-123" })
    });

    db.prepare(
      `INSERT INTO session_locks (session_key, owner, locked_at, expires_at)
       VALUES (?, ?, ?, ?)`
    ).run(
      sessionKey,
      "dead-process-owner",
      "2026-04-09T10:00:00.000Z",
      "2099-04-09T10:01:00.000Z"
    );

    const calls: string[] = [];

    await expect(
      sessionStore.withSessionLock(sessionKey, async () => {
        calls.push("entered");
      })
    ).resolves.toBeUndefined();

    expect(calls).toEqual(["entered"]);
    const remainingLocks = db
      .prepare(`SELECT COUNT(*) AS count FROM session_locks WHERE session_key = ?`)
      .get(sessionKey) as { count: number };
    expect(remainingLocks.count).toBe(0);
  });
});
