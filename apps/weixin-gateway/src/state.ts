import fs from "node:fs";
import path from "node:path";

export type WeixinStoredAccount = {
  accountId: string;
  token: string;
  baseUrl: string;
  userId?: string;
};

export type WeixinGatewayStateData = {
  syncCursor: string;
  contextTokens: Record<string, string>;
  accounts: Record<string, WeixinStoredAccount>;
  defaultAccountId: string;
};

const EMPTY_STATE: WeixinGatewayStateData = {
  syncCursor: "",
  contextTokens: {},
  accounts: {},
  defaultAccountId: "default"
};

export class WeixinGatewayStateStore {
  private state: WeixinGatewayStateData = structuredClone(EMPTY_STATE);

  constructor(private readonly filePath: string) {
    this.reload();
  }

  reload(): void {
    this.state = loadStateFromDisk(this.filePath);
  }

  getSyncCursor(): string {
    return this.state.syncCursor;
  }

  setSyncCursor(cursor: string): void {
    this.state.syncCursor = sanitizeText(cursor);
    this.persist();
  }

  getContextToken(accountId: string, peerId: string): string {
    return this.state.contextTokens[buildContextTokenKey(accountId, peerId)] ?? "";
  }

  setContextToken(accountId: string, peerId: string, token: string): void {
    const key = buildContextTokenKey(accountId, peerId);
    const normalizedToken = sanitizeText(token);
    if (!key || !normalizedToken) {
      return;
    }
    this.state.contextTokens[key] = normalizedToken;
    this.persist();
  }

  getStoredAccount(accountId: string): WeixinStoredAccount | null {
    const normalizedAccountId = sanitizeText(accountId) || this.state.defaultAccountId;
    return this.state.accounts[normalizedAccountId] ?? null;
  }

  setStoredAccount(account: WeixinStoredAccount): void {
    const normalizedAccountId = sanitizeText(account.accountId) || "default";
    this.state.accounts[normalizedAccountId] = {
      accountId: normalizedAccountId,
      token: sanitizeText(account.token),
      baseUrl: sanitizeText(account.baseUrl),
      ...(sanitizeText(account.userId) ? { userId: sanitizeText(account.userId) } : {})
    };
    this.state.defaultAccountId = normalizedAccountId;
    this.persist();
  }

  clearStoredAccount(accountId: string): void {
    const normalizedAccountId = sanitizeText(accountId) || this.state.defaultAccountId;
    delete this.state.accounts[normalizedAccountId];

    for (const key of Object.keys(this.state.contextTokens)) {
      if (key.startsWith(`${normalizedAccountId}:`)) {
        delete this.state.contextTokens[key];
      }
    }

    if (this.state.defaultAccountId === normalizedAccountId) {
      this.state.defaultAccountId = Object.keys(this.state.accounts)[0] ?? "default";
    }
    this.persist();
  }

  resolveRuntimeAccount(preferredAccountId: string, envOverride: {
    token?: string | null;
    baseUrl?: string | null;
  }): WeixinStoredAccount | null {
    const normalizedPreferred = sanitizeText(preferredAccountId) || this.state.defaultAccountId;
    const stored =
      this.state.accounts[normalizedPreferred]
      ?? this.state.accounts[this.state.defaultAccountId]
      ?? null;

    const token = sanitizeText(envOverride.token) || sanitizeText(stored?.token);
    const baseUrl = sanitizeText(envOverride.baseUrl) || sanitizeText(stored?.baseUrl);
    if (!token || !baseUrl) {
      return null;
    }

    return {
      accountId: sanitizeText(stored?.accountId) || normalizedPreferred || "default",
      token,
      baseUrl,
      ...(sanitizeText(stored?.userId) ? { userId: sanitizeText(stored?.userId) } : {})
    };
  }

  private persist(): void {
    persistStateToDisk(this.filePath, this.state);
  }
}

function loadStateFromDisk(filePath: string): WeixinGatewayStateData {
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return structuredClone(EMPTY_STATE);
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<WeixinGatewayStateData>;
    return {
      syncCursor: sanitizeText(parsed.syncCursor),
      contextTokens: normalizeContextTokens(parsed.contextTokens),
      accounts: normalizeAccounts(parsed.accounts),
      defaultAccountId: sanitizeText(parsed.defaultAccountId) || "default"
    };
  } catch {
    return structuredClone(EMPTY_STATE);
  }
}

function persistStateToDisk(filePath: string, state: WeixinGatewayStateData): void {
  const tempFile = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tempFile, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tempFile, filePath);
}

function normalizeContextTokens(
  input: WeixinGatewayStateData["contextTokens"] | undefined
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!input || typeof input !== "object") {
    return result;
  }

  for (const [key, value] of Object.entries(input)) {
    const normalizedKey = sanitizeText(key);
    const normalizedValue = sanitizeText(value);
    if (!normalizedKey || !normalizedValue) {
      continue;
    }
    result[normalizedKey] = normalizedValue;
  }
  return result;
}

function normalizeAccounts(
  input: WeixinGatewayStateData["accounts"] | undefined
): Record<string, WeixinStoredAccount> {
  const result: Record<string, WeixinStoredAccount> = {};
  if (!input || typeof input !== "object") {
    return result;
  }

  for (const [key, value] of Object.entries(input)) {
    const accountId = sanitizeText(key);
    const token = sanitizeText(value?.token);
    const baseUrl = sanitizeText(value?.baseUrl);
    if (!accountId || !token || !baseUrl) {
      continue;
    }

    result[accountId] = {
      accountId,
      token,
      baseUrl,
      ...(sanitizeText(value?.userId) ? { userId: sanitizeText(value?.userId) } : {})
    };
  }
  return result;
}

function buildContextTokenKey(accountId: string, peerId: string): string {
  const normalizedAccountId = sanitizeText(accountId);
  const normalizedPeerId = sanitizeText(peerId);
  if (!normalizedAccountId || !normalizedPeerId) {
    return "";
  }
  return `${normalizedAccountId}:${normalizedPeerId}`;
}

function sanitizeText(value: unknown): string {
  return String(value ?? "").trim();
}
