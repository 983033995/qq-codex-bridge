import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type PersistedQqGatewaySession = {
  accountKey: string;
  appId: string;
  sessionId: string;
  lastSeq: number;
  lastConnectedAt: number;
  savedAt: number;
};

export type LoadedQqGatewaySession = {
  sessionId: string;
  lastSeq: number;
};

export interface QqGatewaySessionStore {
  load(): LoadedQqGatewaySession | null;
  save(state: LoadedQqGatewaySession): void;
  clear(): void;
}

type FileQqGatewaySessionStoreOptions = {
  now?: () => number;
  maxAgeMs?: number;
};

export class FileQqGatewaySessionStore implements QqGatewaySessionStore {
  private readonly now: () => number;
  private readonly maxAgeMs: number;

  constructor(
    private readonly filePath: string,
    private readonly accountKey: string,
    private readonly appId: string,
    options: FileQqGatewaySessionStoreOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.maxAgeMs = options.maxAgeMs ?? 5 * 60 * 1000;
  }

  load(): LoadedQqGatewaySession | null {
    try {
      const payload = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<PersistedQqGatewaySession>;
      const now = this.now();

      if (payload.accountKey !== this.accountKey || payload.appId !== this.appId) {
        this.clear();
        return null;
      }

      if (
        typeof payload.sessionId !== "string"
        || typeof payload.lastSeq !== "number"
        || typeof payload.savedAt !== "number"
      ) {
        this.clear();
        return null;
      }

      if (now - payload.savedAt > this.maxAgeMs) {
        this.clear();
        return null;
      }

      return {
        sessionId: payload.sessionId,
        lastSeq: payload.lastSeq
      };
    } catch {
      return null;
    }
  }

  save(state: LoadedQqGatewaySession): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const now = this.now();
    const payload: PersistedQqGatewaySession = {
      accountKey: this.accountKey,
      appId: this.appId,
      sessionId: state.sessionId,
      lastSeq: state.lastSeq,
      lastConnectedAt: now,
      savedAt: now
    };

    writeFileSync(this.filePath, JSON.stringify(payload, null, 2), "utf8");
  }

  clear(): void {
    try {
      rmSync(this.filePath, { force: true });
    } catch {
      // ignore cleanup failures
    }
  }
}
