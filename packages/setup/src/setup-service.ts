import type { SetupChannel, SetupSession, SetupStatus, SetupSubmission } from "./types.js";

export interface SetupRepository {
  get(setupId: string): Promise<SetupSession | null>;
  findActive(channel: SetupChannel, accountId: string): Promise<SetupSession | null>;
  save(session: SetupSession): Promise<void>;
  list(input?: { channel?: SetupChannel; accountId?: string }): Promise<SetupSession[]>;
}

export type ChannelSetupRuntime = {
  loginStatus?(channelId: string): Promise<unknown>;
  startLogin?(channelId: string, force: boolean): Promise<unknown>;
  logout?(channelId: string): Promise<unknown>;
  health?(channelId: string): Promise<{ status: string; message: string }>;
  test?(channelId: string): Promise<unknown>;
};

export type ConfigureChannelInput = {
  channel: SetupChannel;
  accountId: string;
  appId?: string;
  secretRef?: string;
  clientSecret?: string;
};

export class SetupService {
  private readonly now: () => Date;

  constructor(private readonly options: {
    repository: SetupRepository;
    configureChannel(input: ConfigureChannelInput): Promise<{ restartRequired: boolean }>;
    channels?: ChannelSetupRuntime;
    nextId(): string;
    now?: () => Date;
  }) {
    this.now = options.now ?? (() => new Date());
  }

  list(input: { channel?: SetupChannel; accountId?: string } = {}): Promise<SetupSession[]> {
    return this.options.repository.list(input);
  }

  async get(setupId: string): Promise<SetupSession> {
    const session = await this.requireSession(setupId);
    return this.refresh(session);
  }

  async start(input: { channel: SetupChannel; accountId: string; force?: boolean }): Promise<SetupSession> {
    const accountId = required(input.accountId, "accountId");
    const existing = await this.options.repository.findActive(input.channel, accountId);
    if (existing && !input.force) return this.refresh(existing);
    if (existing) await this.cancel(existing.setupId);
    const at = this.now().toISOString();
    const session: SetupSession = {
      setupId: this.options.nextId(),
      channel: input.channel,
      accountId,
      status: input.channel === "weixin" ? "requesting_qr" : "awaiting_input",
      message: input.channel === "weixin" ? "正在生成微信登录二维码" : `请提交 ${channelName(input.channel)} App ID 与 Client Secret`,
      artifact: input.channel === "weixin" ? null : {
        type: "form",
        fields: [
          { name: "appId", secret: false, required: true },
          { name: "clientSecret", secret: true, required: true }
        ]
      },
      errorCode: null,
      createdAt: at,
      updatedAt: at
    };
    await this.options.repository.save(session);
    if (input.channel !== "weixin") return session;

    try {
      await this.options.configureChannel({ channel: "weixin", accountId });
      const login = await this.requireChannelHandler("startLogin")(channelId("weixin", accountId), Boolean(input.force));
      return this.persistLoginState(session, login);
    } catch (error) {
      return this.fail(session, "SETUP_START_FAILED", error);
    }
  }

  async submit(setupId: string, input: SetupSubmission): Promise<SetupSession> {
    const session = await this.requireSession(setupId);
    if (session.channel === "weixin") {
      throw new Error("微信 Setup 使用二维码，不接受字段提交");
    }
    if (isTerminal(session.status)) return session;
    const appId = required(input.appId, "appId");
    const clientSecret = required(input.clientSecret, "clientSecret");
    const secretRef = `${session.channel}/${safeRefSegment(session.accountId)}/client-secret`;
    try {
      const configured = await this.options.configureChannel({
        channel: session.channel,
        accountId: session.accountId,
        appId,
        secretRef,
        clientSecret
      });
      const updated = updateSession(session, {
        status: configured.restartRequired ? "restart_required" : "action_required",
        message: configured.restartRequired
          ? `${channelName(session.channel)}配置已安全保存，需要重启 Runtime 后验证连接`
          : `${channelName(session.channel)}配置已保存，正在等待连接验证`,
        artifact: null,
        errorCode: null
      }, this.now());
      await this.options.repository.save(updated);
      return configured.restartRequired ? updated : this.refresh(updated);
    } catch (error) {
      return this.fail(session, "SETUP_SUBMIT_FAILED", error);
    }
  }

  async cancel(setupId: string): Promise<SetupSession> {
    const session = await this.requireSession(setupId);
    if (isTerminal(session.status)) return session;
    if (session.channel === "weixin" && this.options.channels?.logout) {
      await this.options.channels.logout(channelId(session.channel, session.accountId)).catch(() => undefined);
    }
    const cancelled = updateSession(session, {
      status: "cancelled",
      message: "Setup 已取消",
      artifact: null,
      errorCode: null
    }, this.now());
    await this.options.repository.save(cancelled);
    return cancelled;
  }

  private async refresh(session: SetupSession): Promise<SetupSession> {
    if (isTerminal(session.status) || session.status === "awaiting_input") return session;
    const id = channelId(session.channel, session.accountId);
    if (session.channel === "weixin") {
      try {
        const login = await this.requireChannelHandler("loginStatus")(id);
        return this.persistLoginState(session, login);
      } catch (error) {
        return this.fail(session, "SETUP_STATUS_FAILED", error);
      }
    }
    if (session.status !== "restart_required" && session.status !== "action_required") return session;
    const health = await this.options.channels?.health?.(id).catch(() => null);
    if (health?.status === "ready") {
      const connected = updateSession(session, {
        status: "connected",
        message: `${channelName(session.channel)}渠道已连接`,
        artifact: null,
        errorCode: null
      }, this.now());
      await this.options.repository.save(connected);
      return connected;
    }
    if (session.status === "restart_required") return session;
    const pending = updateSession(session, {
      status: "action_required",
      message: health?.message ?? `${channelName(session.channel)}渠道尚未连接`,
      artifact: null,
      errorCode: "CHANNEL_NOT_READY"
    }, this.now());
    await this.options.repository.save(pending);
    return pending;
  }

  private async persistLoginState(session: SetupSession, value: unknown): Promise<SetupSession> {
    const login = asLoginState(value);
    const status = loginStatus(login.status);
    const updated = updateSession(session, {
      status,
      message: login.message,
      artifact: login.qrCodeContent ? {
        type: "qr_code",
        content: login.qrCodeContent,
        ...(login.expiresAt ? { expiresAt: login.expiresAt } : {})
      } : null,
      errorCode: status === "failed" ? "WEIXIN_LOGIN_FAILED" : null
    }, this.now());
    await this.options.repository.save(updated);
    return updated;
  }

  private async fail(session: SetupSession, errorCode: string, error: unknown): Promise<SetupSession> {
    const failed = updateSession(session, {
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
      artifact: null,
      errorCode
    }, this.now());
    await this.options.repository.save(failed);
    return failed;
  }

  private requireChannelHandler<T extends "startLogin" | "loginStatus">(
    name: T
  ): NonNullable<ChannelSetupRuntime[T]> {
    const handler = this.options.channels?.[name];
    if (!handler) throw new Error(`Channel ${name} is unavailable`);
    return handler as NonNullable<ChannelSetupRuntime[T]>;
  }

  private async requireSession(setupId: string): Promise<SetupSession> {
    const session = await this.options.repository.get(required(setupId, "setupId"));
    if (!session) throw new Error(`Setup session '${setupId}' was not found`);
    return session;
  }
}

function updateSession(
  session: SetupSession,
  patch: Pick<SetupSession, "status" | "message" | "artifact" | "errorCode">,
  now: Date
): SetupSession {
  return { ...session, ...patch, updatedAt: now.toISOString() };
}

function asLoginState(value: unknown): {
  status: string;
  message: string;
  qrCodeContent?: string;
  expiresAt?: string;
} {
  if (!value || typeof value !== "object") throw new Error("微信登录状态无效");
  const record = value as Record<string, unknown>;
  if (typeof record.status !== "string" || typeof record.message !== "string") {
    throw new Error("微信登录状态缺少必要字段");
  }
  return {
    status: record.status,
    message: record.message,
    ...(typeof record.qrCodeContent === "string" ? { qrCodeContent: record.qrCodeContent } : {}),
    ...(typeof record.expiresAt === "string" ? { expiresAt: record.expiresAt } : {})
  };
}

function loginStatus(status: string): SetupStatus {
  if (status === "logged_in") return "connected";
  if (status === "awaiting_scan" || status === "scanned") return "awaiting_scan";
  if (status === "awaiting_confirmation") return "awaiting_confirmation";
  if (status === "requesting_qr") return "requesting_qr";
  return "failed";
}

function isTerminal(status: SetupStatus): boolean {
  return status === "connected" || status === "failed" || status === "cancelled";
}

function channelId(channel: SetupChannel, accountId: string): string {
  return `${channel}:${accountId}`;
}

function channelName(channel: SetupChannel): string {
  return { qq: "QQ", weixin: "微信", feishu: "飞书" }[channel];
}

function safeRefSegment(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error("accountId 无法生成安全的 Secret Reference");
  return normalized.slice(0, 64);
}

function required(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}
