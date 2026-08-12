export type PushApiClientOptions = {
  baseUrl: string;
  token: string;
  fetchFn?: typeof fetch;
};

export class PushApiClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: PushApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
    if (!this.baseUrl) {
      throw new Error("MCP push API base URL is required");
    }
    assertLoopbackBaseUrl(this.baseUrl);
    if (Buffer.byteLength(options.token, "utf8") < 32) {
      throw new Error("MCP push token must contain at least 32 bytes");
    }
  }

  async push(idempotencyKey: string, payload: unknown): Promise<unknown> {
    return this.request("/api/v1/push", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey
      },
      body: JSON.stringify(payload)
    });
  }

  listTargets(): Promise<unknown> {
    return this.request("/api/v1/push-targets");
  }

  getStatus(pushId: string): Promise<unknown> {
    return this.request(`/api/v1/push/${encodeURIComponent(pushId)}`);
  }

  private async request(pathname: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${pathname}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          ...init.headers
        }
      });
    } catch (error) {
      throw new Error(
        `push API is unavailable at ${this.baseUrl}: ${networkErrorMessage(error)}`,
        { cause: error }
      );
    }
    const body = await readResponseBody(response);
    if (!response.ok) {
      throw new Error(`push API request failed (${response.status}): ${errorMessage(body)}`);
    }
    return body;
  }
}

function networkErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = error.cause;
  if (cause instanceof Error && cause.message) {
    return cause.message;
  }
  return error.message || "network request failed";
}

function assertLoopbackBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("MCP push API base URL must be a valid HTTP URL");
  }
  const hostname = parsed.hostname.toLowerCase();
  const ipv4Parts = hostname.split(".").map(Number);
  const isIpv4Loopback = ipv4Parts.length === 4
    && ipv4Parts[0] === 127
    && ipv4Parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
  const isLoopback = hostname === "localhost"
    || hostname === "[::1]"
    || hostname === "::1"
    || isIpv4Loopback;
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username
    || parsed.password
    || !isLoopback) {
    throw new Error("MCP push API base URL must use HTTP on a loopback host without embedded credentials");
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function errorMessage(body: unknown): string {
  if (!body || typeof body !== "object") {
    return "unknown error";
  }
  const record = body as Record<string, unknown>;
  const nested = record.error;
  if (nested && typeof nested === "object" && typeof (nested as Record<string, unknown>).message === "string") {
    return (nested as Record<string, unknown>).message as string;
  }
  return typeof record.message === "string" ? record.message : "unknown error";
}
