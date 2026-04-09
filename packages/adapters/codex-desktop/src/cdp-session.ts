export type CdpSessionConfig = {
  appName: string;
  remoteDebuggingPort: number;
};

type FetchLike = typeof fetch;

type CdpSessionOptions = {
  fetchFn?: FetchLike;
};

export type CdpBrowserConnection = {
  appName: string;
  browserVersion: string;
  browserWebSocketUrl: string;
};

export type CdpTarget = {
  id: string;
  title: string;
  type: string;
  url: string;
};

export class CdpSession {
  private readonly fetchFn: FetchLike;
  private connection: CdpBrowserConnection | null = null;

  constructor(
    readonly config: CdpSessionConfig,
    options: CdpSessionOptions = {}
  ) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async connect(): Promise<CdpBrowserConnection> {
    if (this.connection) {
      return this.connection;
    }

    const response = await this.fetchFn(
      `http://127.0.0.1:${this.config.remoteDebuggingPort}/json/version`
    );

    if (!response.ok) {
      throw new Error(`CDP connect failed: ${response.status}`);
    }

    const payload = (await response.json()) as {
      Browser?: string;
      webSocketDebuggerUrl?: string;
    };

    if (!payload.webSocketDebuggerUrl) {
      throw new Error("CDP version response missing webSocketDebuggerUrl");
    }

    this.connection = {
      appName: this.config.appName,
      browserVersion: payload.Browser ?? "unknown",
      browserWebSocketUrl: payload.webSocketDebuggerUrl
    };

    return this.connection;
  }

  getBrowserWebSocketUrl(): string | null {
    return this.connection?.browserWebSocketUrl ?? null;
  }

  async listTargets(): Promise<CdpTarget[]> {
    const response = await this.fetchFn(
      `http://127.0.0.1:${this.config.remoteDebuggingPort}/json/list`
    );

    if (!response.ok) {
      throw new Error(`CDP target listing failed: ${response.status}`);
    }

    const payload = (await response.json()) as Array<{
      id?: string;
      title?: string;
      type?: string;
      url?: string;
    }>;

    return payload.map((target) => ({
      id: target.id ?? "",
      title: target.title ?? "",
      type: target.type ?? "unknown",
      url: target.url ?? ""
    }));
  }
}
