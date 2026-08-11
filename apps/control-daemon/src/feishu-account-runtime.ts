import { createHash } from "node:crypto";
import type { InboundMessage } from "../../../packages/domain/src/message.js";
import {
  createFeishuChannelAdapter,
  type FeishuChannelAdapter
} from "../../../packages/adapters/feishu/src/feishu-channel-adapter.js";
import type { Attachment, ComponentHealth } from "../../../packages/domain/src/vnext/index.js";
import type { SecretStorePort } from "../../../packages/ports/src/vnext/index.js";
import type { ControlDaemonComponent } from "./composition-root.js";

type FetchLike = typeof fetch;

export type FeishuRuntimeInbound = {
  accountId: string;
  providerMessageId: string;
  peerId: string;
  chatType: "c2c" | "group";
  senderId: string;
  text: string;
  attachments: Attachment[];
  sequence: number;
  receivedAt: string;
};

export class FeishuAccountRuntime implements ControlDaemonComponent {
  readonly name: string;
  readonly critical = false;
  private readonly fetchFn: FetchLike;
  private readonly createAdapter: typeof createFeishuChannelAdapter;
  private readonly since = new Date().toISOString();
  private adapter: FeishuChannelAdapter | null = null;
  private state: "idle" | "starting" | "ready" | "degraded" | "stopped" = "idle";
  private lastError: string | null = null;
  private lastSuccessAt: string | null = null;
  private sequence = 0;

  constructor(private readonly options: {
    accountId: string;
    appId: string;
    secretRef: string;
    secrets: SecretStorePort;
    onInbound(message: FeishuRuntimeInbound): Promise<void>;
    onError?(error: Error): void;
    onIgnoredMessage?(diagnostic: {
      reason: string;
      senderType: string;
      messageType: string;
      hasMessageId: boolean;
      hasChatId: boolean;
      hasSenderId: boolean;
      contentLength: number;
    }): void;
    fetchFn?: FetchLike;
    createAdapter?: typeof createFeishuChannelAdapter;
  }) {
    this.name = `channel:feishu:${options.accountId}`;
    this.fetchFn = options.fetchFn ?? fetch;
    this.createAdapter = options.createAdapter ?? createFeishuChannelAdapter;
  }

  async start(): Promise<void> {
    if (this.state === "ready" || this.state === "starting") return;
    this.state = "starting";
    try {
      const secret = await this.requiredSecret();
      await this.testCredentials(secret);
      const adapter = this.createAdapter({
        accountKey: `feishu:${this.options.accountId}`,
        appId: this.options.appId,
        appSecret: secret,
        onDispatchError: (error) => this.recordError(error),
        onIgnoredMessage: (diagnostic) => this.options.onIgnoredMessage?.(diagnostic)
      });
      adapter.ingress.onMessage((message) => this.acceptInbound(message));
      await adapter.ingress.start();
      this.adapter = adapter;
      this.state = "ready";
      this.lastError = null;
      this.lastSuccessAt = new Date().toISOString();
    } catch (error) {
      this.adapter = null;
      this.state = "degraded";
      this.recordError(normalizeError(error));
    }
  }

  async stop(): Promise<void> {
    const adapter = this.adapter;
    this.adapter = null;
    if (adapter) await adapter.ingress.stop();
    this.state = "stopped";
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
    if (this.state !== "ready") {
      throw new Error(this.lastError ?? "Feishu runtime failed to restart");
    }
  }

  async health(): Promise<ComponentHealth> {
    if (this.state === "ready") {
      return {
        component: this.name,
        status: "ready",
        message: "飞书凭据有效，事件长连接已启动",
        since: this.since,
        ...(this.lastSuccessAt ? { lastSuccessAt: this.lastSuccessAt } : {})
      };
    }
    return {
      component: this.name,
      status: this.state === "idle" || this.state === "stopped" ? "offline" : "degraded",
      code: "FEISHU_RUNTIME_NOT_READY",
      message: this.lastError ?? `飞书运行时状态：${this.state}`,
      since: this.since,
      suggestedAction: "在管理台运行飞书渠道测试，检查应用凭据和长连接事件订阅"
    };
  }

  async test(): Promise<{ ok: true; botName: string | null; message: string }> {
    const result = await this.testCredentials(await this.requiredSecret());
    this.lastError = null;
    this.lastSuccessAt = new Date().toISOString();
    return {
      ok: true,
      botName: result.botName,
      message: this.state === "ready"
        ? "飞书凭据、机器人 API 与事件长连接均正常"
        : "飞书凭据和机器人 API 正常，但事件长连接尚未就绪"
    };
  }

  async deliver(input: {
    deliveryKey: string;
    accountId: string;
    peerId: string;
    chatType: "c2c" | "group";
    text: string;
    attachments?: Attachment[];
  }): Promise<string | null> {
    if (input.accountId !== `feishu:${this.options.accountId}`) {
      throw new Error(`Feishu account '${input.accountId}' is not handled by ${this.name}`);
    }
    if (!this.adapter || this.state !== "ready") {
      throw new Error(`Feishu runtime '${input.accountId}' is not ready`);
    }
    if ((input.attachments?.length ?? 0) > 0) {
      throw new Error("Feishu vNext replies currently support text only");
    }
    const delivered = await this.adapter.egress.deliver({
      draftId: feishuUuid(input.deliveryKey),
      sessionKey: `${input.accountId}::fs:${input.chatType}:${input.peerId}`,
      text: input.text,
      createdAt: new Date().toISOString()
    });
    this.lastSuccessAt = new Date().toISOString();
    return delivered.providerMessageId;
  }

  private async acceptInbound(message: InboundMessage): Promise<void> {
    this.sequence += 1;
    this.lastSuccessAt = new Date().toISOString();
    await this.options.onInbound({
      accountId: `feishu:${this.options.accountId}`,
      providerMessageId: message.messageId,
      peerId: message.peerKey.split(":").at(-1) ?? "",
      chatType: message.chatType,
      senderId: message.senderId,
      text: message.text,
      attachments: [],
      sequence: this.sequence,
      receivedAt: message.receivedAt
    });
  }

  private async requiredSecret(): Promise<string> {
    const secret = await this.options.secrets.get(this.options.secretRef);
    if (!secret) throw new Error(`飞书 Secret '${this.options.secretRef}' 不存在`);
    return secret;
  }

  private async testCredentials(secret: string): Promise<{ botName: string | null }> {
    const auth = await this.fetchFn("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: this.options.appId, app_secret: secret })
    });
    const authPayload = await readJson(auth);
    const token = isRecord(authPayload) && typeof authPayload.tenant_access_token === "string"
      ? authPayload.tenant_access_token
      : null;
    if (!auth.ok || readCode(authPayload) !== 0 || !token) {
      throw new Error(`飞书凭据验证失败（HTTP ${auth.status}, code ${readCode(authPayload)}）`);
    }
    const bot = await this.fetchFn("https://open.feishu.cn/open-apis/bot/v3/info", {
      headers: { Authorization: `Bearer ${token}` }
    });
    const botPayload = await readJson(bot);
    if (!bot.ok || readCode(botPayload) !== 0) {
      throw new Error(`飞书机器人 API 验证失败（HTTP ${bot.status}, code ${readCode(botPayload)}）`);
    }
    const botRecord = isRecord(botPayload) && isRecord(botPayload.bot)
      ? botPayload.bot
      : isRecord(botPayload) && isRecord(botPayload.data) && isRecord(botPayload.data.bot)
        ? botPayload.data.bot
        : null;
    return { botName: botRecord && typeof botRecord.app_name === "string" ? botRecord.app_name : null };
  }

  private recordError(error: Error): void {
    this.lastError = error.message;
    this.options.onError?.(error);
  }
}

function feishuUuid(deliveryKey: string): string {
  return createHash("sha256").update(deliveryKey).digest("hex").slice(0, 32);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    throw new Error(`飞书 API 返回了无效 JSON（HTTP ${response.status}）`);
  }
}

function readCode(value: unknown): number {
  return isRecord(value) && typeof value.code === "number" ? value.code : -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
