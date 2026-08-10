export type ApiEnvelope<T> = {
  data: T;
  requestId: string;
};

export type ApiErrorEnvelope = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId: string;
};

export class ControlApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ControlApiError";
  }
}

type SessionState = {
  csrfToken: string;
  expiresAt: string;
};

export class ControlApiClient {
  private session: SessionState | null = null;
  private sessionRequest: Promise<SessionState> | null = null;

  constructor(
    private readonly basePath = "/api/v1",
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "POST", body: JSON.stringify(body) });
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "PUT", body: JSON.stringify(body) });
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "DELETE" });
  }

  eventStreamUrl(): string {
    return `${this.basePath}/events`;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const session = await this.ensureSession();
    const method = init.method ?? "GET";
    const response = await this.fetchFn(`${this.basePath}${normalizePath(path)}`, {
      ...init,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(method === "GET" ? {} : { "X-CSRF-Token": session.csrfToken }),
        ...init.headers
      }
    });
    const payload = await readJson(response);
    if (!response.ok) {
      if (response.status === 401) {
        this.session = null;
      }
      throw toApiError(response.status, payload);
    }
    if (!isRecord(payload) || !("data" in payload)) {
      throw new ControlApiError(response.status, "INVALID_RESPONSE", "管理 API 返回了无效响应", null);
    }
    return payload.data as T;
  }

  private ensureSession(): Promise<SessionState> {
    if (this.session && Date.parse(this.session.expiresAt) > Date.now()) {
      return Promise.resolve(this.session);
    }
    if (!this.sessionRequest) {
      this.sessionRequest = this.fetchFn(`${this.basePath}/session`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" }
      })
        .then(async (response) => {
          const payload = await readJson(response);
          if (!response.ok || !isRecord(payload) || !isRecord(payload.data)) {
            throw toApiError(response.status, payload);
          }
          const csrfToken = requiredString(payload.data.csrfToken, "csrfToken");
          const expiresAt = requiredString(payload.data.expiresAt, "expiresAt");
          if (!Number.isFinite(Date.parse(expiresAt))) {
            throw new ControlApiError(response.status, "INVALID_RESPONSE", "管理 Session 到期时间无效", null);
          }
          this.session = { csrfToken, expiresAt };
          return this.session;
        })
        .finally(() => {
          this.sessionRequest = null;
        });
    }
    return this.sessionRequest;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    throw new ControlApiError(response.status, "INVALID_RESPONSE", "管理 API 返回了非 JSON 响应", null);
  }
}

function toApiError(status: number, payload: unknown): ControlApiError {
  if (isRecord(payload) && isRecord(payload.error)) {
    return new ControlApiError(
      status,
      typeof payload.error.code === "string" ? payload.error.code : "REQUEST_FAILED",
      typeof payload.error.message === "string" ? payload.error.message : "管理请求失败",
      typeof payload.requestId === "string" ? payload.requestId : null,
      payload.error.details
    );
  }
  return new ControlApiError(status, "REQUEST_FAILED", "管理请求失败", null);
}

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ControlApiError(200, "INVALID_RESPONSE", `管理 API 缺少 ${field}`, null);
  }
  return value;
}

export const controlApi = new ControlApiClient();
