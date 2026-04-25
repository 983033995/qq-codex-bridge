import crypto from "node:crypto";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { MediaArtifactKind, type MediaArtifact } from "../../../packages/domain/src/message.js";
import type { WeixinGatewayConfig } from "./config.js";
import type { WeixinGatewayStateStore } from "./state.js";

type FetchLike = typeof fetch;
const WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

type WeixinMediaType = 1 | 2 | 3;
type WeixinCdnMedia = {
  encrypt_query_param: string;
  aes_key: string;
  encrypt_type: 1;
};

type UploadedWeixinArtifact = {
  artifact: MediaArtifact;
  fileData: Buffer;
  fileMd5: string;
  media: WeixinCdnMedia;
};

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
  onQrCode?: (url: string) => void;
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
    await this.sendMessage({
      peerId,
      chatType: "c2c",
      content: text,
      contextToken
    });
  }

  async sendMessage(target: {
    peerId: string;
    chatType: "c2c" | "group";
    content?: string;
    mediaArtifacts?: MediaArtifact[];
    contextToken?: string | null;
  }): Promise<void> {
    const normalizedPeerId = sanitizeText(target.peerId);
    if (!normalizedPeerId) {
      throw new Error("weixin target user id is missing");
    }

    const content = sanitizeText(target.content);
    const mediaArtifacts = target.mediaArtifacts ?? [];
    if (!content && mediaArtifacts.length === 0) {
      throw new Error("weixin outbound payload requires text or media artifacts");
    }

    const itemList: Array<Record<string, unknown>> = [];
    if (content) {
      itemList.push({
        type: 1,
        text_item: { text: content }
      });
    }

    for (const item of await this.buildMediaItems(normalizedPeerId, mediaArtifacts)) {
      itemList.push(item);
    }

    const payload = {
      msg: {
        from_user_id: "",
        to_user_id: normalizedPeerId,
        client_id: crypto.randomUUID(),
        message_type: 2,
        message_state: 2,
        ...(sanitizeText(target.contextToken)
          ? { context_token: sanitizeText(target.contextToken) }
          : {}),
        item_list: itemList
      },
      base_info: {
        channel_version: "qq-codex-bridge"
      }
    };

    const response = await this.request("ilink/bot/sendmessage", payload, this.options.apiTimeoutMs);
    assertWeixinSuccess(response, "sendmessage");
  }

  private async buildMediaItems(
    peerId: string,
    mediaArtifacts: MediaArtifact[]
  ): Promise<Array<Record<string, unknown>>> {
    const items: Array<Record<string, unknown>> = [];

    for (let index = 0; index < mediaArtifacts.length; index += 1) {
      const artifact = mediaArtifacts[index]!;
      if (
        artifact.kind === MediaArtifactKind.Image
        && isLikelyVideoThumbnail(artifact)
        && mediaArtifacts[index + 1]?.kind === MediaArtifactKind.Video
      ) {
        const thumbnail = await this.uploadArtifact(peerId, artifact);
        const video = await this.uploadArtifact(peerId, mediaArtifacts[index + 1]!);
        items.push({
          type: 5,
          video_item: {
            media: video.media,
            video_size: video.fileData.length,
            video_md5: video.fileMd5,
            thumb_media: thumbnail.media
          }
        });
        index += 1;
        continue;
      }

      items.push(await this.buildStandaloneMediaItem(peerId, artifact));
    }

    return items;
  }

  private async buildStandaloneMediaItem(
    peerId: string,
    artifact: MediaArtifact
  ): Promise<Record<string, unknown>> {
    const uploaded = await this.uploadArtifact(peerId, artifact);
    const fileName = sanitizeText(artifact.originalName) || inferFileNameFromArtifact(artifact);

    switch (artifact.kind) {
      case MediaArtifactKind.Image:
        return {
          type: 2,
          image_item: {
            media: uploaded.media,
            mid_size: uploaded.fileData.length
          }
        };
      case MediaArtifactKind.Video:
        return {
          type: 5,
          video_item: {
            media: uploaded.media,
            video_size: uploaded.fileData.length,
            video_md5: uploaded.fileMd5
          }
        };
      case MediaArtifactKind.File:
      default:
        return {
          type: 4,
          file_item: {
            media: uploaded.media,
            file_name: fileName,
            md5: uploaded.fileMd5,
            len: String(uploaded.fileData.length)
          }
        };
    }
  }

  private async uploadArtifact(
    peerId: string,
    artifact: MediaArtifact
  ): Promise<UploadedWeixinArtifact> {
    const fileData = await readArtifactData(this.fetchFn, artifact);
    const fileMd5 = createHash("md5").update(fileData).digest("hex");
    const upload = await this.uploadMedia(peerId, artifact, fileData, fileMd5);
    return {
      artifact,
      fileData,
      fileMd5,
      media: upload.media
    };
  }

  private async uploadMedia(
    peerId: string,
    artifact: MediaArtifact,
    fileData: Buffer,
    fileMd5: string
  ): Promise<{ media: WeixinCdnMedia }> {
    const aesKey = randomBytes(16);
    const encryptedData = encryptAesEcb(fileData, aesKey);
    const filekey = randomBytes(16).toString("hex");
    const mediaType = mapArtifactKindToMediaType(artifact.kind);
    const uploadResponse = (await this.request(
      "ilink/bot/getuploadurl",
      {
        filekey,
        media_type: mediaType,
        to_user_id: peerId,
        rawsize: fileData.length,
        rawfilemd5: fileMd5,
        filesize: encryptedData.length,
        no_need_thumb: true,
        aeskey: aesKey.toString("hex"),
        base_info: {
          channel_version: "qq-codex-bridge"
        }
      },
      this.options.apiTimeoutMs
    )) as {
      ret?: number;
      errcode?: number;
      errmsg?: string;
      upload_param?: string;
      upload_full_url?: string;
    };
    assertWeixinSuccess(uploadResponse, "getuploadurl");

    const uploadUrl =
      sanitizeText(uploadResponse.upload_full_url)
      || `${WEIXIN_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(sanitizeText(uploadResponse.upload_param))}&filekey=${encodeURIComponent(filekey)}`;
    if (!uploadUrl.includes("upload")) {
      throw new Error("weixin getuploadurl returned no usable upload url");
    }

    const cdnResponse = await this.fetchFn(uploadUrl, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream"
      },
      body: new Uint8Array(encryptedData),
      signal: AbortSignal.timeout(60_000)
    });
    if (!cdnResponse.ok) {
      const cdnText = await cdnResponse.text().catch(() => "");
      throw new Error(
        `weixin cdn upload failed: ${cdnResponse.status}${cdnText ? ` ${cdnText}` : ""}`
      );
    }

    const encryptQueryParam = sanitizeText(cdnResponse.headers.get("x-encrypted-param"));
    if (!encryptQueryParam) {
      throw new Error("weixin cdn upload response missing x-encrypted-param");
    }

    return {
      media: {
        encrypt_query_param: encryptQueryParam,
        aes_key: Buffer.from(aesKey.toString("hex"), "utf8").toString("base64"),
        encrypt_type: 1
      }
    };
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

function mapArtifactKindToMediaType(kind: MediaArtifactKind): WeixinMediaType {
  switch (kind) {
    case MediaArtifactKind.Image:
      return 1;
    case MediaArtifactKind.Video:
      return 2;
    case MediaArtifactKind.File:
    default:
      return 3;
  }
}

async function readArtifactData(fetchFn: FetchLike, artifact: MediaArtifact): Promise<Buffer> {
  const localPath = sanitizeText(artifact.localPath);
  if (localPath) {
    try {
      return await fs.readFile(localPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  const sourceUrl = sanitizeText(artifact.sourceUrl);
  if (!/^https?:\/\//.test(sourceUrl)) {
    throw new Error(`weixin media file not found: ${localPath || sourceUrl || "unknown"}`);
  }

  const response = await fetchFn(sourceUrl);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`weixin media download failed: ${response.status}${body ? ` ${body}` : ""}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function inferFileNameFromArtifact(artifact: MediaArtifact): string {
  const source = sanitizeText(artifact.originalName)
    || path.basename(sanitizeText(artifact.localPath))
    || path.basename(sanitizeText(artifact.sourceUrl));
  return source || "weixin-media";
}

function isLikelyVideoThumbnail(artifact: MediaArtifact): boolean {
  const filename = inferFileNameFromArtifact(artifact).toLowerCase();
  return (
    artifact.kind === MediaArtifactKind.Image
    && (
      filename.includes("thumbnail")
      || filename.includes("thumb")
      || filename.includes("poster")
      || filename.includes("cover")
    )
  );
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
  options.onQrCode?.(qrcodeUrl);

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
