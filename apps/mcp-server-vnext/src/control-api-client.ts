import type { SetupChannel, SetupSession, SetupSubmission } from "../../../packages/setup/src/index.js";
import type {
  ApprovalRequest,
  ApprovalResolution,
  ApprovalStatus
} from "../../../packages/approval/src/index.js";

export interface GatewayControlClient {
  reset(baseUrl: string): void;
  listSetup(input?: { channel?: SetupChannel; accountId?: string }): Promise<SetupSession[]>;
  getSetup(setupId: string): Promise<SetupSession>;
  startSetup(input: { channel: SetupChannel; accountId: string; force?: boolean }): Promise<SetupSession>;
  submitSetup(setupId: string, input: SetupSubmission): Promise<SetupSession>;
  cancelSetup(setupId: string): Promise<SetupSession>;
  listApprovals(input?: { status?: ApprovalStatus; threadId?: string; limit?: number }): Promise<ApprovalRequest[]>;
  getApproval(approvalId: string): Promise<ApprovalRequest>;
  resolveApproval(approvalId: string, resolution: ApprovalResolution): Promise<ApprovalRequest>;
}

export class LocalControlApiClient implements GatewayControlClient {
  private baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private session: { cookie: string; csrfToken: string } | null = null;

  constructor(options: { baseUrl: string; fetchFn?: typeof fetch }) {
    this.baseUrl = safeLoopbackBaseUrl(options.baseUrl);
    this.fetchFn = options.fetchFn ?? fetch;
  }

  reset(baseUrl: string): void {
    this.baseUrl = safeLoopbackBaseUrl(baseUrl);
    this.session = null;
  }

  async listSetup(input: { channel?: SetupChannel; accountId?: string } = {}): Promise<SetupSession[]> {
    const query = new URLSearchParams();
    if (input.channel) query.set("channel", input.channel);
    if (input.accountId) query.set("accountId", input.accountId);
    return this.request(`/setup${query.size ? `?${query}` : ""}`);
  }

  getSetup(setupId: string): Promise<SetupSession> {
    return this.request(`/setup/${encodeURIComponent(setupId)}`);
  }

  startSetup(input: { channel: SetupChannel; accountId: string; force?: boolean }): Promise<SetupSession> {
    return this.request("/setup", { method: "POST", body: JSON.stringify(input) });
  }

  submitSetup(setupId: string, input: SetupSubmission): Promise<SetupSession> {
    return this.request(`/setup/${encodeURIComponent(setupId)}/submit`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  cancelSetup(setupId: string): Promise<SetupSession> {
    return this.request(`/setup/${encodeURIComponent(setupId)}/cancel`, {
      method: "POST",
      body: "{}"
    });
  }

  async listApprovals(input: { status?: ApprovalStatus; threadId?: string; limit?: number } = {}): Promise<ApprovalRequest[]> {
    const query = new URLSearchParams();
    if (input.status) query.set("status", input.status);
    if (input.threadId) query.set("threadId", input.threadId);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    return this.request(`/approvals${query.size ? `?${query}` : ""}`);
  }

  getApproval(approvalId: string): Promise<ApprovalRequest> {
    return this.request(`/approvals/${encodeURIComponent(approvalId)}`);
  }

  resolveApproval(approvalId: string, resolution: ApprovalResolution): Promise<ApprovalRequest> {
    return this.request(`/approvals/${encodeURIComponent(approvalId)}/resolve`, {
      method: "POST",
      body: JSON.stringify({ resolution })
    });
  }

  private async request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const session = await this.ensureSession();
    const method = init.method ?? "GET";
    const response = await this.fetchFn(`${this.baseUrl}/api/v1${pathname}`, {
      ...init,
      headers: {
        Accept: "application/json",
        Cookie: session.cookie,
        ...(method === "GET" ? {} : {
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrfToken
        }),
        ...init.headers
      }
    });
    const payload = await readPayload(response);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) this.session = null;
      throw new Error(controlApiError(payload, response.status));
    }
    return (payload as { data: T }).data;
  }

  private async ensureSession(): Promise<{ cookie: string; csrfToken: string }> {
    if (this.session) return this.session;
    const response = await this.fetchFn(`${this.baseUrl}/api/v1/session`, {
      headers: { Accept: "application/json" }
    });
    const payload = await readPayload(response);
    if (!response.ok) throw new Error(controlApiError(payload, response.status));
    const setCookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    const csrfToken = (payload as { data?: { csrfToken?: unknown } }).data?.csrfToken;
    if (!setCookie || typeof csrfToken !== "string") {
      throw new Error("Control API did not issue a complete local session");
    }
    this.session = { cookie: setCookie, csrfToken };
    return this.session;
  }
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function controlApiError(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;
    if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
      return `Control API request failed (${status}): ${(error as { message: string }).message}`;
    }
  }
  return `Control API request failed (${status})`;
}

function safeLoopbackBaseUrl(value: string): string {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const parts = host.split(".").map(Number);
  const loopback = host === "localhost" || host === "::1" || host === "[::1]"
    || (parts.length === 4 && parts[0] === 127 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255));
  if (url.protocol !== "http:" || !loopback || url.username || url.password || url.pathname !== "/") {
    throw new Error("Control API base URL must use HTTP on a loopback host without credentials or a path");
  }
  return value.replace(/\/+$/, "");
}
