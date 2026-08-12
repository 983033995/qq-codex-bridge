import { createHash } from "node:crypto";
import type { SecretStorePort } from "../../ports/src/vnext/index.js";
import { WeixinLoginStateStore, type PersistedWeixinLoginState } from "./login-state-store.js";
import type {
  WeixinLoginCredential,
  WeixinLoginProvider,
  WeixinLoginState,
  WeixinLoginStatus
} from "./login-types.js";

type ActiveFlow = { controller: AbortController; completion: Promise<void> };

export type WeixinLoginManagerOptions = {
  provider: WeixinLoginProvider;
  secrets: SecretStorePort;
  stateStore: WeixinLoginStateStore;
  loginBaseUrl?: string;
  qrTotalTimeoutMs?: number;
  pollDelayMs?: number;
  now?: () => Date;
  sleep?: (durationMs: number) => Promise<void>;
  onState?(state: WeixinLoginState): void;
};

export class WeixinLoginManager {
  private readonly states = new Map<string, WeixinLoginState>();
  private readonly persisted = new Map<string, PersistedWeixinLoginState>();
  private readonly flows = new Map<string, ActiveFlow>();
  private persistence: Promise<void> = Promise.resolve();
  private readonly now: () => Date;
  private readonly sleep: (durationMs: number) => Promise<void>;
  private readonly qrTotalTimeoutMs: number;
  private readonly pollDelayMs: number;
  private readonly loginBaseUrl: string;

  private constructor(private readonly options: WeixinLoginManagerOptions) {
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));
    this.qrTotalTimeoutMs = positiveInteger(options.qrTotalTimeoutMs ?? 8 * 60_000, "qrTotalTimeoutMs");
    this.pollDelayMs = nonNegativeInteger(options.pollDelayMs ?? 1_000, "pollDelayMs");
    this.loginBaseUrl = safeBaseUrl(options.loginBaseUrl ?? "https://ilinkai.weixin.qq.com");
  }

  static async create(options: WeixinLoginManagerOptions): Promise<WeixinLoginManager> {
    const manager = new WeixinLoginManager(options);
    const persisted = await options.stateStore.read();
    let requiresPersist = false;
    for (const [accountId, state] of Object.entries(persisted)) {
      if (state.status === "logged_in" && state.secretRef && await options.secrets.get(state.secretRef)) {
        manager.persisted.set(accountId, state);
        manager.states.set(accountId, manager.publicState(accountId, "logged_in", state.updatedAt));
      } else if (state.status === "logged_in") {
        requiresPersist = true;
        const updatedAt = manager.now().toISOString();
        manager.persisted.set(accountId, { status: "invalid", updatedAt });
        manager.states.set(accountId, manager.publicState(accountId, "invalid", updatedAt));
      } else if (isInProgress(state.status)) {
        requiresPersist = true;
        const updatedAt = manager.now().toISOString();
        manager.persisted.set(accountId, { status: "expired", updatedAt });
        manager.states.set(accountId, manager.publicState(accountId, "expired", updatedAt));
      } else {
        manager.persisted.set(accountId, state);
        manager.states.set(accountId, manager.publicState(accountId, state.status, state.updatedAt, state.expiresAt));
      }
    }
    if (requiresPersist) await manager.persistAll();
    return manager;
  }

  getState(accountId: string): WeixinLoginState {
    const normalized = required(accountId, "accountId");
    return structuredClone(this.states.get(normalized) ?? this.publicState(normalized, "logged_out", this.now().toISOString()));
  }

  listStates(): WeixinLoginState[] {
    return [...this.states.values()].map((state) => structuredClone(state)).sort((left, right) => left.accountId.localeCompare(right.accountId));
  }

  async startLogin(accountId: string, force = false): Promise<WeixinLoginState> {
    const normalized = required(accountId, "accountId");
    const current = this.getState(normalized);
    if (current.status === "logged_in" && !force) return current;
    const active = this.flows.get(normalized);
    if (active && !force) return current;
    if (active) {
      active.controller.abort();
      await active.completion.catch(() => undefined);
    }
    if (force) await this.options.secrets.delete(secretRefFor(normalized));

    const controller = new AbortController();
    await this.setState(normalized, "requesting_qr");
    let qr;
    try {
      qr = await this.options.provider.createQr(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) await this.setState(normalized, "invalid");
      throw error;
    }
    const expiresAt = new Date(this.now().getTime() + this.qrTotalTimeoutMs).toISOString();
    await this.setState(normalized, "awaiting_scan", { qrCodeContent: qr.qrCodeContent, expiresAt });
    const completion = this.runFlow(normalized, qr.sessionId, expiresAt, controller)
      .finally(() => {
        if (this.flows.get(normalized)?.controller === controller) this.flows.delete(normalized);
      });
    this.flows.set(normalized, { controller, completion });
    void completion.catch(() => undefined);
    return this.getState(normalized);
  }

  async logout(accountId: string): Promise<WeixinLoginState> {
    const normalized = required(accountId, "accountId");
    const active = this.flows.get(normalized);
    if (active) {
      active.controller.abort();
      await active.completion.catch(() => undefined);
      this.flows.delete(normalized);
    }
    await this.options.secrets.delete(secretRefFor(normalized));
    await this.setState(normalized, "logged_out");
    return this.getState(normalized);
  }

  async invalidate(accountId: string): Promise<WeixinLoginState> {
    const normalized = required(accountId, "accountId");
    const active = this.flows.get(normalized);
    if (active) {
      active.controller.abort();
      await active.completion.catch(() => undefined);
      this.flows.delete(normalized);
    }
    await this.options.secrets.delete(secretRefFor(normalized));
    await this.setState(normalized, "invalid");
    return this.getState(normalized);
  }

  async getCredential(accountId: string): Promise<WeixinLoginCredential | null> {
    const state = this.persisted.get(required(accountId, "accountId"));
    if (state?.status !== "logged_in" || !state.secretRef) return null;
    const value = await this.options.secrets.get(state.secretRef);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<WeixinLoginCredential>;
    if (!parsed.token || !parsed.baseUrl) throw new Error("Stored Weixin login credential is invalid");
    return { token: parsed.token, baseUrl: safeBaseUrl(parsed.baseUrl), ...(parsed.userId ? { userId: parsed.userId } : {}) };
  }

  async stop(): Promise<void> {
    const active = [...this.flows.values()];
    for (const flow of active) flow.controller.abort();
    await Promise.all(active.map((flow) => flow.completion.catch(() => undefined)));
    this.flows.clear();
  }

  private async runFlow(accountId: string, sessionId: string, expiresAt: string, controller: AbortController): Promise<void> {
    let baseUrl = this.loginBaseUrl;
    try {
      while (!controller.signal.aborted && this.now().getTime() < Date.parse(expiresAt)) {
        const result = await this.options.provider.poll(sessionId, baseUrl, controller.signal);
        if (result.status === "wait") {
          await this.sleep(this.pollDelayMs);
          continue;
        }
        if (result.status === "scanned") {
          await this.setState(accountId, "scanned", { ...qrFields(this.getState(accountId)), expiresAt });
          await this.sleep(this.pollDelayMs);
          continue;
        }
        if (result.status === "awaiting_confirmation") {
          if (result.redirectBaseUrl) baseUrl = safeBaseUrl(result.redirectBaseUrl);
          await this.setState(accountId, "awaiting_confirmation", { ...qrFields(this.getState(accountId)), expiresAt });
          continue;
        }
        if (result.status === "expired") {
          await this.setState(accountId, "expired");
          return;
        }
        if (result.status === "invalid") {
          await this.setState(accountId, "invalid");
          return;
        }
        const secretRef = secretRefFor(accountId);
        await this.options.secrets.set(secretRef, JSON.stringify(result.credential));
        await this.setState(accountId, "logged_in", { secretRef });
        return;
      }
      if (!controller.signal.aborted) await this.setState(accountId, "expired");
    } catch (error) {
      if (!controller.signal.aborted) await this.setState(accountId, "invalid");
      throw error;
    }
  }

  private async setState(
    accountId: string,
    status: WeixinLoginStatus,
    extra: { qrCodeContent?: string; expiresAt?: string; secretRef?: string } = {}
  ): Promise<void> {
    const updatedAt = this.now().toISOString();
    const state = this.publicState(accountId, status, updatedAt, extra.expiresAt, extra.qrCodeContent);
    this.persisted.set(accountId, {
      status,
      updatedAt,
      ...(extra.expiresAt ? { expiresAt: extra.expiresAt } : {}),
      ...(extra.secretRef ? { secretRef: extra.secretRef } : {})
    });
    await this.persistAll();
    this.states.set(accountId, state);
    this.options.onState?.(structuredClone(state));
  }

  private publicState(
    accountId: string,
    status: WeixinLoginStatus,
    updatedAt: string,
    expiresAt?: string,
    qrCodeContent?: string
  ): WeixinLoginState {
    return {
      accountId,
      status,
      message: statusMessage(status),
      updatedAt,
      ...(qrCodeContent ? { qrCodeContent } : {}),
      ...(expiresAt ? { expiresAt } : {})
    };
  }

  private async persistAll(): Promise<void> {
    const snapshot = Object.fromEntries(this.persisted);
    const write = () => this.options.stateStore.write(snapshot);
    const pending = this.persistence.then(write, write);
    this.persistence = pending.catch(() => undefined);
    await pending;
  }
}

function statusMessage(status: WeixinLoginStatus): string {
  return {
    logged_out: "尚未登录",
    requesting_qr: "正在生成二维码",
    awaiting_scan: "请使用微信扫码",
    scanned: "二维码已扫描",
    awaiting_confirmation: "请在微信中确认登录",
    logged_in: "微信已登录",
    expired: "二维码已过期",
    invalid: "登录态已失效"
  }[status];
}

function secretRefFor(accountId: string): string {
  return `weixin/session/${createHash("sha256").update(accountId).digest("hex").slice(0, 32)}`;
}

function isInProgress(status: WeixinLoginStatus): boolean {
  return status === "requesting_qr" || status === "awaiting_scan" || status === "scanned" || status === "awaiting_confirmation";
}

function qrFields(state: WeixinLoginState): { qrCodeContent?: string } {
  return state.qrCodeContent ? { qrCodeContent: state.qrCodeContent } : {};
}

function safeBaseUrl(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new Error("Weixin base URL must use HTTPS, except HTTP loopback is allowed for tests");
  }
  return url.toString().replace(/\/$/, "");
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  return value;
}
