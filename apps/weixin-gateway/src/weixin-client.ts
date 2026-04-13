import crypto from "node:crypto";
import type { WeixinGatewayConfig } from "./config.js";
import type { WeixinGatewayStateStore } from "./state.js";

type FetchLike = typeof fetch;

export type WeixinInboundMessage = {
  from_user_id?: string;
  message_id?: string;
  seq?: number;
  session_id?: string;
  context_token?: string;
  message_type?: number;
  message_state?: number;
  item_list?: Array<{
    type?: number;
    text_item?: { text?: string };
    voice_item?: { text?: string };
  }>;
};

type WeixinClientOptions = {
  accountId: string;
  baseUrl: string;
  token: string;
  longPollTimeoutMs: number;
  apiTimeoutMs: number;
  stateStore: WeixinGatewayStateStore;
  onInboundMessage(message: WeixinInboundMessage): Promise<void>;
  fetchFn?: FetchLike;
};

type LoginFlowOptions = {
  accountId: string;
  force?: boolean;
  config: Pick<
    WeixinGatewayConfig,
    "loginBaseUrl"
    | "loginBotType"
    | "qrFetchTimeoutMs"
    | "qrPollTimeoutMs"
    | "qrTotalTimeoutMs"
  >;
  stateStore: WeixinGatewayStateStore;
  fetchFn?: FetchLike;
};

export class WeixinClient {
  private readonly fetchFn: FetchLike;
  private readonly headersUin = Buffer.from(
    String(crypto.randomBytes(4).readUInt32BE(0)),
    "utf8"
  ).toString("base64");
  private stopped = false;
  private runningPromise: Promise<void> | null = null;
  private activePollController: AbortController | null = null;
  ready = false;

  constructor(private readonly options: WeixinClientOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  get accountId(): string {
    return this.options.accountId;
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  get token(): string {
    return this.options.token;
  }

  async connect(): Promise<void> {
    if (this.runningPromise) {
      return this.runningPromise;
    }

    this.stopped = false;
    this.runningPromise = (async () => {
      while (!this.stopped) {
        try {
          await this.pollOnce();
          this.ready = true;
        } catch (error) {
          this.ready = false;
          if (this.stopped) {
            break;
          }
          if ((error as Error)?.name === "AbortError") {
            continue;
          }
          console.warn("[weixin-gateway] poll failed", {
            error: error instanceof Error ? error.message : String(error)
          });
          await sleep(2000);
        }
      }
    })().finally(() => {
      this.runningPromise = null;
      this.ready = false;
    });

    return this.runningPromise;
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    this.activePollController?.abort();
    this.activePollController = null;
    await this.runningPromise?.catch(() => undefined);
  }

  async sendTextMessage(peerId: string, text: string, contextToken?: string | null): Promise<void> {
    const normalizedPeerId = sanitizeText(peerId);
    if (!normalizedPeerId) {
      throw new Error("weixin target user id is missing");
    }

    const payload = {
      msg: {
        from_user_id: "",
        to_user_id: normalizedPeerId,
        client_id: crypto.randomUUID(),
        message_type: 2,
        message_state: 2,
        ...(sanitizeText(contextToken) ? { context_token: sanitizeText(contextToken) } : {}),
        item_list: [
          {
            type: 1,
            text_item: { text: String(text ?? "") }
          }
        ]
      },
      base_info: {
        channel_version: "qq-codex-bridge"
      }
    };

    const response = await this.request("ilink/bot/sendmessage", payload, this.options.apiTimeoutMs);
    assertWeixinSuccess(response, "sendmessage");
  }

  private async pollOnce(): Promise<void> {
    const controller = new AbortController();
    this.activePollController = controller;

    try {
      const response = await this.request(
        "ilink/bot/getupdates",
        {
          get_updates_buf: this.options.stateStore.getSyncCursor(),
          base_info: {
            channel_version: "qq-codex-bridge"
          }
        },
        this.options.longPollTimeoutMs,
        controller
      );

      assertWeixinSuccess(response, "getupdates");

      const nextCursor = sanitizeText((response as { get_updates_buf?: string }).get_updates_buf);
      if (nextCursor) {
        this.options.stateStore.setSyncCursor(nextCursor);
      }

      const messages = Array.isArray((response as { msgs?: unknown[] }).msgs)
        ? ((response as { msgs?: WeixinInboundMessage[] }).msgs ?? [])
        : [];

      for (const message of messages) {
        if (!shouldProcessInboundMessage(message)) {
          continue;
        }

        if (sanitizeText(message.context_token) && sanitizeText(message.from_user_id)) {
          this.options.stateStore.setContextToken(
            this.options.accountId,
            sanitizeText(message.from_user_id),
            sanitizeText(message.context_token)
          );
        }

        await this.options.onInboundMessage(message);
      }
    } finally {
      if (this.activePollController === controller) {
        this.activePollController = null;
      }
    }
  }

  private async request(
    pathname: string,
    body: unknown,
    timeoutMs: number,
    controller?: AbortController
  ): Promise<unknown> {
    const url = new URL(pathname, ensureTrailingSlash(this.options.baseUrl)).toString();
    const response = await requestJsonWithTimeout(this.fetchFn, "POST", url, {
      headers: {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": this.headersUin,
        ...(sanitizeText(this.options.token)
          ? { Authorization: `Bearer ${sanitizeText(this.options.token)}` }
          : {})
      },
      body,
      timeoutMs,
      signal: controller?.signal
    });
    return response;
  }
}

export async function runWeixinLoginFlow(options: LoginFlowOptions): Promise<{
  accountId: string;
  baseUrl: string;
  qrcodeUrl: string;
}> {
  const fetchFn = options.fetchFn ?? fetch;
  const existing = options.stateStore.resolveRuntimeAccount(options.accountId, {
    token: null,
    baseUrl: null
  });
  if (existing && !options.force) {
    return {
      accountId: existing.accountId,
      baseUrl: existing.baseUrl,
      qrcodeUrl: ""
    };
  }

  const qr = await fetchWeixinQrCode(fetchFn, options.config);
  const qrcode = sanitizeText(qr.qrcode);
  const qrcodeUrl = sanitizeText(qr.qrcode_img_content);
  if (!qrcode || !qrcodeUrl) {
    throw new Error("weixin qr login failed: qrcode response is incomplete");
  }

  let currentBaseUrl = options.config.loginBaseUrl;
  const deadline = Date.now() + options.config.qrTotalTimeoutMs;
  while (Date.now() < deadline) {
    const status = await pollWeixinQrStatus(fetchFn, qrcode, currentBaseUrl, options.config.qrPollTimeoutMs);
    const currentStatus = sanitizeText(status.status);

    if (currentStatus === "scaned_but_redirect" && sanitizeText(status.redirect_host)) {
      currentBaseUrl = `https://${sanitizeText(status.redirect_host)}`;
      continue;
    }

    if (currentStatus === "wait" || currentStatus === "scaned") {
      await sleep(1000);
      continue;
    }

    if (currentStatus === "expired") {
      throw new Error("weixin qr code expired before confirmation");
    }

    if (currentStatus === "confirmed") {
      const botToken = sanitizeText(status.bot_token);
      const accountId =
        sanitizeText(status.ilink_bot_id)
        || sanitizeText(options.accountId)
        || "default";
      const baseUrl =
        sanitizeText(status.baseurl)
        || currentBaseUrl
        || options.config.loginBaseUrl;
      if (!botToken) {
        throw new Error("weixin login confirmed but bot token is missing");
      }

      options.stateStore.setStoredAccount({
        accountId,
        token: botToken,
        baseUrl,
        ...(sanitizeText(status.ilink_user_id) ? { userId: sanitizeText(status.ilink_user_id) } : {})
      });

      return {
        accountId,
        baseUrl,
        qrcodeUrl
      };
    }

    throw new Error(`unexpected weixin qr status: ${currentStatus || "unknown"}`);
  }

  throw new Error("weixin login timed out");
}

export async function forwardWeixinInboundToBridge(
  fetchFn: FetchLike,
  target: {
    bridgeBaseUrl: string;
    bridgeWebhookPath: string;
    accountKey: string;
  },
  message: WeixinInboundMessage
): Promise<void> {
  const senderId = sanitizeText(message.from_user_id);
  const text = extractWeixinText(message);
  if (!senderId || !text) {
    return;
  }

  const payload = {
    accountKey: target.accountKey,
    chatType: "c2c",
    senderId,
    peerId: senderId,
    messageId: String(message.message_id || message.seq || message.session_id || Date.now()),
    text,
    receivedAt: new Date().toISOString()
  };

  const response = await fetchFn(`${target.bridgeBaseUrl}${target.bridgeWebhookPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `bridge webhook failed: ${response.status}${body ? ` ${body}` : ""}`
    );
  }
}

export function extractWeixinText(message: WeixinInboundMessage): string {
  if (!message || !Array.isArray(message.item_list)) {
    return "";
  }

  for (const item of message.item_list) {
    if (Number(item?.type) === 1 && typeof item.text_item?.text === "string") {
      return sanitizeText(item.text_item.text);
    }
    if (Number(item?.type) === 3 && typeof item.voice_item?.text === "string") {
      return sanitizeText(item.voice_item.text);
    }
  }

  return "";
}

function shouldProcessInboundMessage(message: WeixinInboundMessage): boolean {
  if (Number(message.message_type || 0) === 2) {
    return false;
  }
  return Boolean(sanitizeText(message.from_user_id) && extractWeixinText(message));
}

async function fetchWeixinQrCode(
  fetchFn: FetchLike,
  config: Pick<WeixinGatewayConfig, "loginBaseUrl" | "loginBotType" | "qrFetchTimeoutMs">
): Promise<Record<string, string>> {
  const url = new URL("ilink/bot/get_bot_qrcode", ensureTrailingSlash(config.loginBaseUrl));
  url.searchParams.set("bot_type", config.loginBotType);
  return requestJsonByText(fetchFn, url.toString(), config.qrFetchTimeoutMs);
}

async function pollWeixinQrStatus(
  fetchFn: FetchLike,
  qrcode: string,
  baseUrl: string,
  timeoutMs: number
): Promise<Record<string, string>> {
  const url = new URL("ilink/bot/get_qrcode_status", ensureTrailingSlash(baseUrl));
  url.searchParams.set("qrcode", qrcode);
  try {
    return await requestJsonByText(fetchFn, url.toString(), timeoutMs);
  } catch (error) {
    if ((error as Error)?.name === "AbortError") {
      return { status: "wait" };
    }
    throw error;
  }
}

async function requestJsonByText(
  fetchFn: FetchLike,
  url: string,
  timeoutMs: number
): Promise<Record<string, string>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, {
      method: "GET",
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${text}`);
    }
    return JSON.parse(text) as Record<string, string>;
  } finally {
    clearTimeout(timer);
  }
}

async function requestJsonWithTimeout(
  fetchFn: FetchLike,
  method: string,
  url: string,
  options: {
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs: number;
    signal?: AbortSignal;
  }
): Promise<unknown> {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetchFn(url, {
      method,
      headers: options.headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ${response.statusText}: ${text || "request failed"}`
      );
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

function assertWeixinSuccess(response: unknown, action: string): void {
  const payload = response as {
    ret?: number;
    errcode?: number;
    errmsg?: string;
  };

  if ((Number(payload?.ret) || 0) !== 0 || (Number(payload?.errcode) || 0) !== 0) {
    throw new Error(
      `weixin ${action} failed: ret=${Number(payload?.ret) || 0} errcode=${Number(payload?.errcode) || 0} errmsg=${sanitizeText(payload?.errmsg) || "unknown error"}`
    );
  }
}

function ensureTrailingSlash(url: string): string {
  return String(url).replace(/\/+$/, "") + "/";
}

function sanitizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
