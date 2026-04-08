import { randomUUID } from "node:crypto";
import type { BridgeSession, BridgeSessionStatus } from "../../domain/src/session.js";
import type { SessionStorePort } from "../../ports/src/store.js";
import type { SqliteDatabase } from "./sqlite.js";

type SessionRow = BridgeSession;

export class SqliteSessionStore implements SessionStorePort {
  private readonly sessionLockTails = new Map<string, Promise<void>>();

  constructor(private readonly db: SqliteDatabase) {}

  async getSession(sessionKey: string): Promise<BridgeSession | null> {
    const row = this.db
      .prepare(
        `SELECT session_key AS sessionKey,
                account_key AS accountKey,
                peer_key AS peerKey,
                chat_type AS chatType,
                peer_id AS peerId,
                codex_thread_ref AS codexThreadRef,
                status,
                last_inbound_at AS lastInboundAt,
                last_outbound_at AS lastOutboundAt,
                last_error AS lastError
         FROM bridge_sessions
         WHERE session_key = ?`
      )
      .get(sessionKey) as SessionRow | undefined;

    return row ?? null;
  }

  async createSession(session: BridgeSession): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO bridge_sessions (
          session_key, account_key, peer_key, chat_type, peer_id,
          codex_thread_ref, status, last_inbound_at, last_outbound_at, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.sessionKey,
        session.accountKey,
        session.peerKey,
        session.chatType,
        session.peerId,
        session.codexThreadRef,
        session.status,
        session.lastInboundAt,
        session.lastOutboundAt,
        session.lastError
      );
  }

  async updateSessionStatus(
    sessionKey: string,
    status: BridgeSessionStatus,
    lastError: string | null = null
  ): Promise<void> {
    this.db
      .prepare(`UPDATE bridge_sessions SET status = ?, last_error = ? WHERE session_key = ?`)
      .run(status, lastError, sessionKey);
  }

  async updateBinding(sessionKey: string, codexThreadRef: string | null): Promise<void> {
    this.db
      .prepare(`UPDATE bridge_sessions SET codex_thread_ref = ? WHERE session_key = ?`)
      .run(codexThreadRef, sessionKey);
  }

  async withSessionLock<T>(sessionKey: string, work: () => Promise<T>): Promise<T> {
    // Queue same-session work in-process so the SQLite lock row reflects a real exclusive section.
    const previousTail = this.sessionLockTails.get(sessionKey) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const currentTail = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const queuedTail = previousTail.then(() => currentTail);

    this.sessionLockTails.set(sessionKey, queuedTail);
    await previousTail;

    const owner = randomUUID();
    const lockedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    this.db
      .prepare(`DELETE FROM session_locks WHERE session_key = ? AND expires_at <= ?`)
      .run(sessionKey, lockedAt);

    this.db
      .prepare(
        `INSERT INTO session_locks (session_key, owner, locked_at, expires_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(sessionKey, owner, lockedAt, expiresAt);

    try {
      return await work();
    } finally {
      this.db.prepare(`DELETE FROM session_locks WHERE session_key = ? AND owner = ?`).run(sessionKey, owner);
      releaseCurrent();
      if (this.sessionLockTails.get(sessionKey) === queuedTail) {
        this.sessionLockTails.delete(sessionKey);
      }
    }
  }
}
