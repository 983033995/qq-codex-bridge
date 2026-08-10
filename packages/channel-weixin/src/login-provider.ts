import { z } from "zod";
import type {
  WeixinLoginCredential,
  WeixinLoginProvider,
  WeixinQrPollResult,
  WeixinQrSession
} from "./login-types.js";

type FetchLike = typeof fetch;

export type HttpWeixinLoginProviderOptions = {
  baseUrl?: string;
  botType?: string;
  qrFetchTimeoutMs?: number;
  qrPollTimeoutMs?: number;
  fetchFn?: FetchLike;
};

const qrResponseSchema = z.object({
  qrcode: z.string().trim().min(1),
  qrcode_img_content: z.string().trim().min(1)
}).passthrough();

const pollResponseSchema = z.object({
  status: z.string().trim(),
  redirect_host: z.string().trim().optional(),
  bot_token: z.string().trim().optional(),
  ilink_bot_id: z.string().trim().optional(),
  ilink_user_id: z.string().trim().optional(),
  baseurl: z.string().trim().optional()
}).passthrough();

export class HttpWeixinLoginProvider implements WeixinLoginProvider {
  private readonly baseUrl: string;
  private readonly botType: string;
  private readonly qrFetchTimeoutMs: number;
  private readonly qrPollTimeoutMs: number;
  private readonly fetchFn: FetchLike;

  constructor(options: HttpWeixinLoginProviderOptions = {}) {
    this.baseUrl = safeBaseUrl(options.baseUrl ?? "https://ilinkai.weixin.qq.com");
    this.botType = required(options.botType ?? "3", "botType");
    this.qrFetchTimeoutMs = positiveInteger(options.qrFetchTimeoutMs ?? 10_000, "qrFetchTimeoutMs");
    this.qrPollTimeoutMs = positiveInteger(options.qrPollTimeoutMs ?? 35_000, "qrPollTimeoutMs");
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async createQr(signal: AbortSignal): Promise<WeixinQrSession> {
    const url = new URL("ilink/bot/get_bot_qrcode", trailingSlash(this.baseUrl));
    url.searchParams.set("bot_type", this.botType);
    const response = qrResponseSchema.parse(await requestJson(
      this.fetchFn,
      url.toString(),
      this.qrFetchTimeoutMs,
      signal
    ));
    return { sessionId: response.qrcode, qrCodeContent: response.qrcode_img_content };
  }

  async poll(sessionId: string, baseUrl: string, signal: AbortSignal): Promise<WeixinQrPollResult> {
    const url = new URL("ilink/bot/get_qrcode_status", trailingSlash(safeBaseUrl(baseUrl)));
    url.searchParams.set("qrcode", required(sessionId, "sessionId"));
    let value: unknown;
    try {
      value = await requestJson(this.fetchFn, url.toString(), this.qrPollTimeoutMs, signal);
    } catch (error) {
      if (!signal.aborted && error instanceof Error && error.name === "AbortError") {
        return { status: "wait" };
      }
      throw error;
    }
    const response = pollResponseSchema.parse(value);
    if (response.status === "wait") return { status: "wait" };
    if (response.status === "scaned") return { status: "scanned" };
    if (response.status === "scaned_but_redirect") {
      return {
        status: "awaiting_confirmation",
        ...(response.redirect_host
          ? { redirectBaseUrl: safeBaseUrl(`https://${response.redirect_host}`) }
          : {})
      };
    }
    if (response.status === "expired") return { status: "expired" };
    if (response.status !== "confirmed") return { status: "invalid" };
    const credential: WeixinLoginCredential = {
      token: required(response.bot_token, "confirmed bot token"),
      baseUrl: safeBaseUrl(response.baseurl || baseUrl),
      ...(response.ilink_user_id ? { userId: response.ilink_user_id } : {})
    };
    return { status: "confirmed", credential };
  }
}

async function requestJson(
  fetchFn: FetchLike,
  url: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetchFn(url, { method: "GET", signal: AbortSignal.any([signal, timeout]) });
  const text = await response.text();
  if (!response.ok) throw new Error(`Weixin login HTTP ${response.status}`);
  return JSON.parse(text) as unknown;
}

function safeBaseUrl(value: string): string {
  const url = new URL(required(value, "Weixin base URL"));
  const loopback = url.hostname === "localhost" || url.hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new Error("Weixin base URL must use HTTPS, except HTTP loopback is allowed for tests");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function trailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function required(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}
