import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { WeixinMessageState } from "./message-types.js";

const stateValueSchema = z.string().trim().min(1).max(1024 * 1024);
const accountStateSchema = z.object({
  cursor: z.string().max(1024 * 1024),
  contextTokens: z.record(stateValueSchema)
}).strict();
const persistedStateSchema = z.object({
  version: z.literal(1),
  accounts: z.record(accountStateSchema)
}).strict();

type PersistedState = z.infer<typeof persistedStateSchema>;

export class WeixinMessageStateStore implements WeixinMessageState {
  private state: PersistedState = { version: 1, accounts: {} };
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    if (!filePath.trim()) throw new Error("Weixin message state file path is required");
  }

  async load(): Promise<void> {
    await this.writeTail;
    try {
      this.state = persistedStateSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")) as unknown);
    } catch (error) {
      if (isNotFound(error)) {
        this.state = { version: 1, accounts: {} };
        return;
      }
      throw new Error("Weixin message state file is invalid", { cause: error });
    }
  }

  getCursor(accountId: string): string {
    return this.state.accounts[required(accountId, "accountId")]?.cursor ?? "";
  }

  setCursor(accountId: string, cursor: string): Promise<void> {
    const normalizedAccountId = required(accountId, "accountId");
    const normalizedCursor = required(cursor, "cursor");
    return this.enqueue(async () => {
      const account = this.account(normalizedAccountId);
      account.cursor = normalizedCursor;
      await this.writeAtomic();
    });
  }

  getContextToken(accountId: string, peerId: string): string {
    return this.state.accounts[required(accountId, "accountId")]?.contextTokens[required(peerId, "peerId")] ?? "";
  }

  setContextToken(accountId: string, peerId: string, token: string): Promise<void> {
    const normalizedAccountId = required(accountId, "accountId");
    const normalizedPeerId = required(peerId, "peerId");
    const normalizedToken = required(token, "contextToken");
    return this.enqueue(async () => {
      const account = this.account(normalizedAccountId);
      account.contextTokens[normalizedPeerId] = normalizedToken;
      await this.writeAtomic();
    });
  }

  private account(accountId: string): PersistedState["accounts"][string] {
    return this.state.accounts[accountId] ??= { cursor: "", contextTokens: {} };
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const pending = this.writeTail.then(work);
    this.writeTail = pending.catch(() => undefined);
    return pending;
  }

  private async writeAtomic(): Promise<void> {
    const value = persistedStateSchema.parse(this.state);
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(
      directory,
      `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`
    );
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporaryPath, this.filePath);
      await syncDirectory(directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
