import {
  createDecipheriv,
  createHash,
  createCipheriv,
  randomBytes,
  randomUUID
} from "node:crypto";
import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  WeixinCdnMedia,
  WeixinInboundTextMessage,
  WeixinMessageAttachment,
  WeixinMessageCredential,
  WeixinMessageState,
  WeixinRawMessage,
  WeixinTextDelivery
} from "./message-types.js";

type FetchLike = typeof fetch;

const WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const WEIXIN_TEXT_SEGMENT_MAX_LENGTH = 1_800;
const DEFAULT_MAX_MEDIA_BYTES = 25 * 1024 * 1024;

export type WeixinMessageClientOptions = {
  accountId: string;
  credential: WeixinMessageCredential;
  state: WeixinMessageState;
  onMessage(message: WeixinInboundTextMessage): Promise<void>;
  longPollTimeoutMs?: number;
  apiTimeoutMs?: number;
  retryDelayMs?: number;
  mediaDirectoryPath?: string;
  maxMediaBytes?: number;
  fetchFn?: FetchLike;
  now?: () => Date;
  sleep?: (durationMs: number) => Promise<void>;
  onError?(error: Error): void;
};

export class WeixinMessageError extends Error {
  constructor(
    readonly code: "WEIXIN_AUTH_INVALID" | "WEIXIN_RATE_LIMITED" | "WEIXIN_HTTP_ERROR",
    readonly retryable: boolean,
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "WeixinMessageError";
  }
}

export class WeixinMessageClient {
  private readonly accountId: string;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: FetchLike;
  private readonly now: () => Date;
  private readonly sleep: (durationMs: number) => Promise<void>;
  private readonly longPollTimeoutMs: number;
  private readonly apiTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly mediaDirectoryPath: string;
  private readonly maxMediaBytes: number;
  private readonly headersUin = Buffer.from(
    String(randomBytes(4).readUInt32BE(0)),
    "utf8"
  ).toString("base64");
  private stopped = true;
  private loop: Promise<void> | null = null;
  private pollController: AbortController | null = null;

  constructor(private readonly options: WeixinMessageClientOptions) {
    this.accountId = required(options.accountId, "accountId");
    this.baseUrl = safeBaseUrl(options.credential.baseUrl);
    this.token = required(options.credential.token, "token");
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));
    this.longPollTimeoutMs = positiveInteger(options.longPollTimeoutMs ?? 35_000, "longPollTimeoutMs");
    this.apiTimeoutMs = positiveInteger(options.apiTimeoutMs ?? 15_000, "apiTimeoutMs");
    this.retryDelayMs = nonNegativeInteger(options.retryDelayMs ?? 2_000, "retryDelayMs");
    this.mediaDirectoryPath = path.resolve(
      options.mediaDirectoryPath ?? path.join(os.tmpdir(), "qq-codex-bridge-vnext", "weixin-media")
    );
    this.maxMediaBytes = positiveInteger(options.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES, "maxMediaBytes");
  }

  start(): void {
    if (this.loop) return;
    this.stopped = false;
    this.loop = this.run().finally(() => {
      this.loop = null;
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.pollController?.abort();
    this.pollController = null;
    await this.loop?.catch(() => undefined);
  }

  async pollOnce(): Promise<number> {
    const controller = new AbortController();
    this.pollController = controller;
    try {
      const response = await this.request("ilink/bot/getupdates", {
        get_updates_buf: this.options.state.getCursor(this.accountId),
        base_info: { channel_version: "qq-codex-bridge-vnext" }
      }, this.longPollTimeoutMs, controller.signal) as { get_updates_buf?: unknown; msgs?: unknown };
      const cursor = optionalString(response?.get_updates_buf);
      const messages = Array.isArray(response?.msgs) ? response.msgs as WeixinRawMessage[] : [];
      let accepted = 0;
      for (const raw of messages) {
        const message = await this.normalizeInbound(raw, controller.signal);
        if (!message) continue;
        const contextToken = optionalString(raw.context_token);
        if (contextToken) {
          await this.options.state.setContextToken(this.accountId, message.peerId, contextToken);
        }
        await this.options.onMessage(message);
        accepted += 1;
      }
      if (cursor) await this.options.state.setCursor(this.accountId, cursor);
      return accepted;
    } finally {
      if (this.pollController === controller) this.pollController = null;
    }
  }

  async deliver(input: WeixinTextDelivery): Promise<string | null> {
    const deliveryKey = required(input.deliveryKey, "delivery.deliveryKey");
    if (required(input.accountId, "delivery.accountId") !== this.accountId) {
      throw new Error("Weixin delivery account does not match the client account");
    }
    const peerId = required(input.peerId, "delivery.peerId");
    const textSegments = splitWeixinTextContent(input.text);
    const attachments = input.attachments ?? [];
    if (textSegments.length === 0 && attachments.length === 0) {
      throw new Error("Weixin delivery requires text or attachments");
    }
    if (attachments.length > 16) throw new Error("Weixin delivery has too many attachments");

    const segments: Array<{ clientId: string; item: Record<string, unknown> }> = [];
    textSegments.forEach((text, index) => {
      segments.push({
        clientId: stableSegmentKey(deliveryKey, "text", index, textSegments.length),
        item: { type: 1, text_item: { text } }
      });
    });
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index]!;
      segments.push({
        clientId: stableSegmentKey(deliveryKey, "media", index, attachments.length),
        item: await this.buildMediaItem(peerId, attachment)
      });
    }

    const contextToken = this.options.state.getContextToken(this.accountId, peerId);
    for (const segment of segments) {
      await this.request("ilink/bot/sendmessage", {
        msg: {
          from_user_id: "",
          to_user_id: peerId,
          client_id: segment.clientId,
          message_type: 2,
          message_state: 2,
          ...(contextToken ? { context_token: contextToken } : {}),
          item_list: [segment.item]
        },
        base_info: { channel_version: "qq-codex-bridge-vnext" }
      }, this.apiTimeoutMs);
    }
    return segments.at(-1)?.clientId ?? null;
  }

  private async normalizeInbound(
    raw: WeixinRawMessage,
    signal: AbortSignal
  ): Promise<WeixinInboundTextMessage | null> {
    const base = normalizeInboundBase(this.accountId, raw, this.now);
    if (!base) return null;
    const textParts = extractWeixinTextParts(raw);
    const attachments: WeixinMessageAttachment[] = [];
    const mediaFailures: string[] = [];

    for (let index = 0; index < (raw.item_list?.length ?? 0); index += 1) {
      const item = raw.item_list![index]!;
      const descriptor = inboundMediaDescriptor(item);
      if (!descriptor) {
        const kind = inboundMediaKind(item);
        if (kind && !(kind === "audio" && optionalString(item.voice_item?.text))) {
          mediaFailures.push(`[收到${mediaKindLabel(kind)}，但微信消息未提供可下载的媒体引用]`);
        }
        continue;
      }
      try {
        attachments.push(await this.downloadInboundMedia({
          providerMessageId: base.providerMessageId,
          index,
          ...descriptor
        }, signal));
      } catch (error) {
        const normalized = normalizeError(error);
        this.options.onError?.(normalized);
        mediaFailures.push(`[收到${mediaKindLabel(descriptor.kind)}，但下载失败：${safeFailureMessage(normalized)}]`);
      }
    }

    const text = [...textParts, ...mediaFailures].join("\n").trim();
    if (!text && attachments.length === 0) return null;
    return { ...base, text, attachments };
  }

  private async downloadInboundMedia(input: {
    providerMessageId: string;
    index: number;
    kind: WeixinMessageAttachment["kind"];
    media: WeixinCdnMedia;
    name: string;
    mimeType: string;
    expectedSize?: number;
    expectedMd5?: string;
    transcript?: string;
  }, signal: AbortSignal): Promise<WeixinMessageAttachment> {
    const encryptedParam = required(input.media.encrypt_query_param, "media.encrypt_query_param");
    if (encryptedParam.length > 8_192) throw new Error("media download parameter is too long");
    if (input.expectedSize !== undefined && input.expectedSize > this.maxMediaBytes) {
      throw new Error(`media exceeds ${this.maxMediaBytes} byte limit`);
    }
    const response = await this.fetchFn(
      `${WEIXIN_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptedParam)}`,
      {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.apiTimeoutMs)])
      }
    );
    if (!response.ok) throw new Error(`media download HTTP ${response.status}`);
    const declaredLength = parseOptionalSize(response.headers.get("content-length"));
    if (declaredLength !== undefined && declaredLength > encryptedSizeLimit(this.maxMediaBytes)) {
      throw new Error(`encrypted media exceeds ${this.maxMediaBytes} byte limit`);
    }
    const encrypted = Buffer.from(await response.arrayBuffer());
    if (encrypted.length > encryptedSizeLimit(this.maxMediaBytes)) {
      throw new Error(`encrypted media exceeds ${this.maxMediaBytes} byte limit`);
    }
    const plaintext = decryptInboundMedia(encrypted, input.media);
    if (plaintext.length > this.maxMediaBytes) throw new Error(`media exceeds ${this.maxMediaBytes} byte limit`);
    if (input.expectedMd5 && md5(plaintext) !== input.expectedMd5.toLowerCase()) {
      throw new Error("media checksum mismatch");
    }

    const accountDirectory = path.join(this.mediaDirectoryPath, sha256(this.accountId).slice(0, 32));
    await mkdir(accountDirectory, { recursive: true, mode: 0o700 });
    await chmod(accountDirectory, 0o700);
    const safeName = safeFileName(input.name, input.kind, input.mimeType);
    const extension = path.extname(safeName);
    const artifactId = sha256(`${this.accountId}\0${input.providerMessageId}\0${input.index}\0${encryptedParam}`);
    const localPath = path.join(accountDirectory, `${artifactId}${extension}`);
    if (!(await exists(localPath))) await writeAtomic(localPath, plaintext);
    return {
      id: `weixin-attachment-${artifactId}`,
      kind: input.kind,
      localPath,
      mimeType: input.mimeType,
      size: plaintext.length,
      name: safeName,
      ...(input.transcript ? { transcript: input.transcript } : {})
    };
  }

  private async buildMediaItem(
    peerId: string,
    attachment: WeixinMessageAttachment
  ): Promise<Record<string, unknown>> {
    const localPath = path.resolve(required(attachment.localPath, "attachment.localPath"));
    if (!path.isAbsolute(attachment.localPath)) throw new Error("Weixin attachment path must be absolute");
    const metadata = await stat(localPath);
    if (!metadata.isFile()) throw new Error("Weixin attachment path must reference a file");
    if (metadata.size > this.maxMediaBytes) throw new Error(`attachment exceeds ${this.maxMediaBytes} byte limit`);
    if (attachment.size !== metadata.size) throw new Error("Weixin attachment size does not match the local file");
    const fileData = await readFile(localPath);
    const fileMd5 = md5(fileData);
    const media = await this.uploadMedia(peerId, attachment.kind, fileData, fileMd5);
    const name = safeFileName(attachment.name ?? path.basename(localPath), attachment.kind, attachment.mimeType);
    switch (attachment.kind) {
      case "image":
        return { type: 2, image_item: { media, mid_size: fileData.length } };
      case "video":
        return { type: 5, video_item: { media, video_size: fileData.length, video_md5: fileMd5 } };
      case "audio":
      case "file":
        return { type: 4, file_item: { media, file_name: name, md5: fileMd5, len: String(fileData.length) } };
    }
  }

  private async uploadMedia(
    peerId: string,
    kind: WeixinMessageAttachment["kind"],
    fileData: Buffer,
    fileMd5: string
  ): Promise<{ encrypt_query_param: string; aes_key: string; encrypt_type: 1 }> {
    const aesKey = randomBytes(16);
    const encryptedData = encryptAesEcb(fileData, aesKey);
    const filekey = randomBytes(16).toString("hex");
    const upload = await this.request("ilink/bot/getuploadurl", {
      filekey,
      media_type: kind === "image" ? 1 : kind === "video" ? 2 : 3,
      to_user_id: peerId,
      rawsize: fileData.length,
      rawfilemd5: fileMd5,
      filesize: encryptedData.length,
      no_need_thumb: true,
      aeskey: aesKey.toString("hex"),
      base_info: { channel_version: "qq-codex-bridge-vnext" }
    }, this.apiTimeoutMs) as { upload_param?: unknown; upload_full_url?: unknown };
    const uploadParam = optionalString(upload.upload_param);
    const uploadUrl = optionalString(upload.upload_full_url)
      ?? (uploadParam
        ? `${WEIXIN_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
        : null);
    if (!uploadUrl || !isAllowedCdnUploadUrl(uploadUrl)) {
      throw new Error("Weixin getuploadurl returned no safe upload URL");
    }
    const response = await this.fetchFn(uploadUrl, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(encryptedData.length)
      },
      body: new Uint8Array(encryptedData),
      redirect: "error",
      signal: AbortSignal.timeout(this.apiTimeoutMs)
    });
    if (!response.ok) throw new Error(`Weixin CDN upload HTTP ${response.status}`);
    const encryptedParam = optionalString(response.headers.get("x-encrypted-param"));
    if (!encryptedParam) throw new Error("Weixin CDN upload response is missing x-encrypted-param");
    return {
      encrypt_query_param: encryptedParam,
      aes_key: Buffer.from(aesKey.toString("hex"), "utf8").toString("base64"),
      encrypt_type: 1
    };
  }

  private async run(): Promise<void> {
    let consecutiveFailures = 0;
    while (!this.stopped) {
      try {
        await this.pollOnce();
        consecutiveFailures = 0;
      } catch (error) {
        if (this.stopped || isAbort(error)) break;
        const normalized = normalizeError(error);
        this.options.onError?.(normalized);
        if (normalized instanceof WeixinMessageError && !normalized.retryable) {
          this.stopped = true;
          break;
        }
        const exponentialDelay = Math.min(
          60_000,
          this.retryDelayMs * 2 ** Math.min(consecutiveFailures, 10)
        );
        consecutiveFailures += 1;
        const retryAfterMs = normalized instanceof WeixinMessageError
          ? normalized.retryAfterMs ?? 0
          : 0;
        await this.sleep(Math.max(exponentialDelay, retryAfterMs));
      }
    }
  }

  private async request(
    pathname: string,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    const response = await this.fetchFn(new URL(pathname, `${this.baseUrl}/`).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": this.headersUin,
        Authorization: `Bearer ${this.token}`
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new WeixinMessageError(
          "WEIXIN_AUTH_INVALID",
          false,
          `Weixin message authentication failed: HTTP ${response.status}`
        );
      }
      if (response.status === 429) {
        throw new WeixinMessageError(
          "WEIXIN_RATE_LIMITED",
          true,
          "Weixin message rate limited: HTTP 429",
          retryAfterMilliseconds(response.headers.get("retry-after"), this.now())
        );
      }
      throw new WeixinMessageError(
        "WEIXIN_HTTP_ERROR",
        response.status >= 500,
        `Weixin message HTTP ${response.status}`
      );
    }
    const payload = text ? JSON.parse(text) as Record<string, unknown> : {};
    const ret = Number(payload.ret ?? 0);
    const errcode = Number(payload.errcode ?? 0);
    if (ret !== 0 || errcode !== 0) {
      throw new Error(`Weixin message request failed: ret=${ret} errcode=${errcode}`);
    }
    return payload;
  }
}

export function normalizeInboundText(
  accountId: string,
  message: WeixinRawMessage,
  now: () => Date = () => new Date()
): WeixinInboundTextMessage | null {
  const base = normalizeInboundBase(accountId, message, now);
  if (!base) return null;
  const text = extractWeixinText(message);
  return text ? { ...base, text, attachments: [] } : null;
}

export function extractWeixinText(message: WeixinRawMessage): string {
  return extractWeixinTextParts(message).join("\n").trim();
}

export function splitWeixinTextContent(
  content: string,
  maxLength = WEIXIN_TEXT_SEGMENT_MAX_LENGTH
): string[] {
  const text = content.trim();
  if (!text) return [];
  positiveInteger(maxLength, "maxLength");
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
    current = "";
  };
  const append = (part: string) => {
    if (!part) return;
    if (current && Array.from(current + part).length > maxLength) flush();
    for (const piece of splitByCodePoints(part, maxLength)) {
      if (current && Array.from(current + piece).length > maxLength) flush();
      if (Array.from(piece).length === maxLength) {
        flush();
        chunks.push(piece.trim());
      } else {
        current += piece;
      }
    }
  };
  for (const part of text.split(/(?<=\n\n)/u)) append(part);
  flush();
  return chunks;
}

function normalizeInboundBase(accountId: string, message: WeixinRawMessage, now: () => Date) {
  if (Number(message.message_type ?? 0) === 2) return null;
  const senderId = optionalString(message.from_user_id);
  if (!senderId) return null;
  const sequence = nonNegativeInteger(Number(message.seq ?? 0), "message.seq");
  const providerMessageId = optionalString(message.message_id)
    ?? optionalString(message.session_id)
    ?? `${senderId}:${sequence}`;
  return {
    accountId: required(accountId, "accountId"),
    providerMessageId,
    senderId,
    peerId: senderId,
    chatType: "c2c" as const,
    sequence,
    receivedAt: now().toISOString()
  };
}

function extractWeixinTextParts(message: WeixinRawMessage): string[] {
  const parts: string[] = [];
  for (const item of message.item_list ?? []) {
    if (Number(item.type) === 1) {
      const text = optionalString(item.text_item?.text);
      if (text) parts.push(text);
    }
    if (Number(item.type) === 3) {
      const transcript = optionalString(item.voice_item?.text);
      if (transcript) parts.push(transcript);
    }
  }
  return parts;
}

function inboundMediaDescriptor(item: NonNullable<WeixinRawMessage["item_list"]>[number]): {
  kind: WeixinMessageAttachment["kind"];
  media: WeixinCdnMedia;
  name: string;
  mimeType: string;
  expectedSize?: number;
  expectedMd5?: string;
  transcript?: string;
} | null {
  const type = Number(item.type);
  if (type === 2 && item.image_item?.media) {
    return {
      kind: "image",
      media: item.image_item.media,
      name: "weixin-image.jpg",
      mimeType: "image/jpeg",
      ...(optionalSize(item.image_item.mid_size) !== undefined ? { expectedSize: optionalSize(item.image_item.mid_size) } : {})
    };
  }
  if (type === 3 && item.voice_item?.media) {
    const transcript = optionalString(item.voice_item.text);
    return {
      kind: "audio",
      media: item.voice_item.media,
      name: "weixin-voice.amr",
      mimeType: "audio/amr",
      ...(optionalSize(item.voice_item.size) !== undefined ? { expectedSize: optionalSize(item.voice_item.size) } : {}),
      ...(transcript ? { transcript } : {})
    };
  }
  if (type === 4 && item.file_item?.media) {
    const name = optionalString(item.file_item.file_name) ?? "weixin-file";
    const md5Value = optionalString(item.file_item.md5);
    return {
      kind: "file",
      media: item.file_item.media,
      name,
      mimeType: mimeTypeFromName(name),
      ...(optionalSize(item.file_item.len) !== undefined ? { expectedSize: optionalSize(item.file_item.len) } : {}),
      ...(md5Value ? { expectedMd5: md5Value } : {})
    };
  }
  if (type === 5 && item.video_item?.media) {
    const md5Value = optionalString(item.video_item.video_md5);
    return {
      kind: "video",
      media: item.video_item.media,
      name: "weixin-video.mp4",
      mimeType: "video/mp4",
      ...(optionalSize(item.video_item.video_size) !== undefined ? { expectedSize: optionalSize(item.video_item.video_size) } : {}),
      ...(md5Value ? { expectedMd5: md5Value } : {})
    };
  }
  return null;
}

function inboundMediaKind(
  item: NonNullable<WeixinRawMessage["item_list"]>[number]
): WeixinMessageAttachment["kind"] | null {
  switch (Number(item.type)) {
    case 2: return "image";
    case 3: return "audio";
    case 4: return "file";
    case 5: return "video";
    default: return null;
  }
}

function decryptInboundMedia(encrypted: Buffer, media: WeixinCdnMedia): Buffer {
  if (media.encrypt_type === undefined || media.encrypt_type === 0) return encrypted;
  if (media.encrypt_type !== 1) throw new Error(`unsupported media encryption type ${media.encrypt_type}`);
  const key = decodeAesKey(required(media.aes_key, "media.aes_key"));
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function decodeAesKey(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 16) return decoded;
  const text = decoded.toString("utf8");
  if (/^[0-9a-f]{32}$/i.test(text)) return Buffer.from(text, "hex");
  if (/^[0-9a-f]{32}$/i.test(value)) return Buffer.from(value, "hex");
  throw new Error("media AES key is invalid");
}

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function splitByCodePoints(text: string, maxLength: number): string[] {
  const characters = Array.from(text);
  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += maxLength) {
    chunks.push(characters.slice(index, index + maxLength).join(""));
  }
  return chunks;
}

function stableSegmentKey(base: string, kind: "text" | "media", index: number, total: number): string {
  if (total === 1 && kind === "text") return base;
  const candidate = `${base}:${kind}:${index + 1}`;
  return candidate.length <= 512 ? candidate : `weixin-delivery-${sha256(candidate)}`;
}

function safeBaseUrl(value: string): string {
  const url = new URL(required(value, "baseUrl"));
  const loopback = url.hostname === "localhost" || url.hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new Error("Weixin message base URL must use HTTPS, except HTTP loopback is allowed for tests");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function isAllowedCdnUploadUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && url.hostname === "novac2c.cdn.weixin.qq.com"
      && url.pathname.startsWith("/c2c/upload");
  } catch {
    return false;
  }
}

async function writeAtomic(filePath: string, data: Buffer): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function safeFileName(value: string, kind: WeixinMessageAttachment["kind"], mimeType: string): string {
  const base = path.basename(value).replace(/[^\p{L}\p{N}._ -]+/gu, "-").trim().slice(0, 160);
  const fallback = `weixin-${kind}${extensionFromMimeType(mimeType)}`;
  return base && base !== "." && base !== ".." ? base : fallback;
}

function mimeTypeFromName(name: string): string {
  switch (path.extname(name).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".amr": return "audio/amr";
    case ".mp4": return "video/mp4";
    case ".txt": return "text/plain";
    case ".pdf": return "application/pdf";
    default: return "application/octet-stream";
  }
}

function extensionFromMimeType(mimeType: string): string {
  const extension: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/amr": ".amr",
    "video/mp4": ".mp4",
    "text/plain": ".txt",
    "application/pdf": ".pdf"
  };
  return extension[mimeType] ?? "";
}

function optionalSize(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseOptionalSize(value: string | null): number | undefined {
  return value === null ? undefined : optionalSize(value);
}

function encryptedSizeLimit(plainLimit: number): number {
  return plainLimit + 16;
}

function retryAfterMilliseconds(value: string | null, now: Date): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(60_000, Math.ceil(seconds * 1_000));
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.min(60_000, Math.max(0, timestamp - now.getTime()));
}

function mediaKindLabel(kind: WeixinMessageAttachment["kind"]): string {
  return kind === "image" ? "图片" : kind === "audio" ? "语音" : kind === "video" ? "视频" : "文件";
}

function safeFailureMessage(error: Error): string {
  if (/checksum/i.test(error.message)) return "校验不一致";
  if (/limit|exceeds/i.test(error.message)) return "文件过大";
  return "媒体服务不可用";
}

function md5(value: Buffer): string {
  return createHash("md5").update(value).digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function required(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  return value;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
