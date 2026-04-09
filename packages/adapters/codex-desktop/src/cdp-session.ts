import WebSocket from "ws";

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

type PendingCommand = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class CdpSession {
  private readonly fetchFn: FetchLike;
  private connection: CdpBrowserConnection | null = null;
  private browserSocket: WebSocket | null = null;
  private browserSocketPromise: Promise<WebSocket> | null = null;
  private nextCommandId = 1;
  private readonly pendingCommands = new Map<number, PendingCommand>();

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

  async evaluateOnPage(expression: string, targetId?: string): Promise<unknown> {
    const target = await this.resolvePageTarget(targetId);
    const sessionId = await this.attachToTarget(target.id);
    const payload = (await this.sendCommand(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true
      },
      sessionId
    )) as {
      result?: {
        value?: unknown;
      };
      exceptionDetails?: unknown;
    };

    if (payload.exceptionDetails) {
      throw new Error("CDP runtime evaluation failed");
    }

    return payload.result?.value;
  }

  private async resolvePageTarget(targetId?: string): Promise<CdpTarget> {
    const targets = await this.listTargets();

    if (targetId) {
      const target = targets.find((candidate) => candidate.id === targetId);
      if (!target) {
        throw new Error(`CDP target not found: ${targetId}`);
      }
      return target;
    }

    const pageTarget = targets.find((candidate) => candidate.type === "page");
    if (!pageTarget) {
      throw new Error("CDP target listing did not include a page target");
    }

    return pageTarget;
  }

  private async attachToTarget(targetId: string): Promise<string> {
    const payload = (await this.sendCommand("Target.attachToTarget", {
      targetId,
      flatten: true
    })) as { sessionId?: string };

    if (!payload.sessionId) {
      throw new Error(`CDP attach failed for target ${targetId}`);
    }

    return payload.sessionId;
  }

  private async sendCommand(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string
  ): Promise<unknown> {
    const socket = await this.getBrowserSocket();
    const id = this.nextCommandId++;

    return new Promise<unknown>((resolve, reject) => {
      this.pendingCommands.set(id, { resolve, reject });

      const command = JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {})
      });

      socket.send(command, (error) => {
        if (!error) {
          return;
        }

        this.pendingCommands.delete(id);
        reject(error);
      });
    });
  }

  private async getBrowserSocket(): Promise<WebSocket> {
    if (this.browserSocket) {
      return this.browserSocket;
    }

    if (this.browserSocketPromise) {
      return this.browserSocketPromise;
    }

    this.browserSocketPromise = this.connectBrowserSocket();
    return this.browserSocketPromise;
  }

  private async connectBrowserSocket(): Promise<WebSocket> {
    const connection = await this.connect();

    return new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(connection.browserWebSocketUrl);

      const cleanup = () => {
        socket.off("open", handleOpen);
        socket.off("error", handleError);
      };

      const handleOpen = () => {
        cleanup();
        this.browserSocket = socket;
        this.browserSocketPromise = null;
        socket.on("message", (payload) => {
          this.handleSocketMessage(payload.toString());
        });
        socket.on("close", () => {
          this.browserSocket = null;
          const pending = Array.from(this.pendingCommands.values());
          this.pendingCommands.clear();
          for (const command of pending) {
            command.reject(new Error("CDP browser websocket closed"));
          }
        });
        resolve(socket);
      };

      const handleError = (error: Error) => {
        cleanup();
        this.browserSocketPromise = null;
        reject(error);
      };

      socket.once("open", handleOpen);
      socket.once("error", handleError);
    });
  }

  private handleSocketMessage(payload: string): void {
    const message = JSON.parse(payload) as {
      id?: number;
      result?: unknown;
      error?: {
        message?: string;
      };
    };

    if (typeof message.id !== "number") {
      return;
    }

    const pending = this.pendingCommands.get(message.id);
    if (!pending) {
      return;
    }

    this.pendingCommands.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error.message ?? "CDP command failed"));
      return;
    }

    pending.resolve(message.result);
  }
}
