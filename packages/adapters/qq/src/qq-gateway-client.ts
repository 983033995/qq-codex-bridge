import WebSocket from "ws";
import type { InboundMessage } from "../../../domain/src/message.js";
import type { QqIngressPort, QqMediaDownloadPort } from "../../../ports/src/qq.js";
import { QqGateway } from "./qq-gateway.js";
import type { QqGatewaySessionStore } from "./qq-gateway-session-store.js";

const QQ_GATEWAY_INTENTS =
  (1 << 30) | // PUBLIC_GUILD_MESSAGES
  (1 << 12) | // DIRECT_MESSAGE
  (1 << 25) | // GROUP_AND_C2C
  (1 << 26); // INTERACTION

const DEFAULT_RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000, 60000];
const RATE_LIMIT_DELAY_MS = 60000;

type QqGatewayApiClient = {
  getAccessToken(): Promise<string>;
  getGatewayUrl(): Promise<string>;
  invalidateAccessToken?(): void;
};

type LoadedSession = {
  sessionId: string;
  lastSeq: number;
};

type GatewayPayload = {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
};

type QqGatewayClientConfig = {
  accountKey: string;
  appId: string;
  apiClient: QqGatewayApiClient;
  sessionStore: QqGatewaySessionStore;
  mediaDownloader?: QqMediaDownloadPort;
  reconnectDelaysMs?: number[];
};

export class QqGatewayClient implements QqIngressPort {
  private readonly gateway: QqGateway;
  private readonly reconnectDelaysMs: number[];
  private socket: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private currentSession: LoadedSession | null;
  private currentAccessToken: string | null = null;
  private reconnectAttempt = 0;
  private startingPromise: Promise<void> | null = null;
  private started = false;
  private shouldInvalidateToken = false;
  private nextReconnectDelayMs: number | null = null;

  constructor(private readonly config: QqGatewayClientConfig) {
    this.gateway = new QqGateway({
      accountKey: config.accountKey,
      mediaDownloader: config.mediaDownloader
    });
    this.reconnectDelaysMs = config.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    this.currentSession = config.sessionStore.load();
  }

  async onMessage(handler: (message: InboundMessage) => Promise<void>): Promise<void> {
    await this.gateway.onMessage(handler);
  }

  async start(): Promise<void> {
    this.started = true;
    if (!this.startingPromise) {
      this.startingPromise = this.connect().finally(() => {
        this.startingPromise = null;
      });
    }
    await this.startingPromise;
  }

  async stop(): Promise<void> {
    this.started = false;
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const socket = this.socket;
    this.socket = null;
    if (!socket) {
      return;
    }

    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close();
      setTimeout(resolve, 100);
    });
  }

  private async connect(): Promise<void> {
    if (!this.started || this.socket) {
      return;
    }

    if (this.shouldInvalidateToken) {
      this.config.apiClient.invalidateAccessToken?.();
      this.shouldInvalidateToken = false;
    }

    const accessToken = await this.config.apiClient.getAccessToken();
    this.currentAccessToken = accessToken;
    const gatewayUrl = await this.config.apiClient.getGatewayUrl();
    const socket = new WebSocket(gatewayUrl);

    socket.on("message", (payload) => {
      void this.handleSocketMessage(socket, payload.toString());
    });

    socket.on("close", (code) => {
      this.onSocketClosed(socket, code);
    });

    socket.on("error", (error) => {
      console.error("[qq-codex-bridge] qq gateway socket error", { error });
    });

    await this.waitForSocketOpen(socket);

    if (!this.started) {
      socket.close();
      return;
    }

    this.socket = socket;
    this.reconnectAttempt = 0;
  }

  private async waitForSocketOpen(socket: WebSocket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.off("open", handleOpen);
        socket.off("error", handleError);
      };

      const handleOpen = () => {
        cleanup();
        resolve();
      };

      const handleError = (error: Error) => {
        cleanup();
        reject(error);
      };

      socket.once("open", handleOpen);
      socket.once("error", handleError);
    });
  }

  private async handleSocketMessage(socket: WebSocket, rawPayload: string): Promise<void> {
    let payload: GatewayPayload;
    try {
      payload = JSON.parse(rawPayload) as GatewayPayload;
    } catch (error) {
      console.error("[qq-codex-bridge] qq gateway payload parse failed", { error, rawPayload });
      return;
    }

    if (typeof payload.s === "number") {
      this.updateLastSeq(payload.s);
    }

    switch (payload.op) {
      case 10:
        await this.handleHello(socket, payload);
        return;
      case 0:
        await this.handleDispatch(payload);
        return;
      case 7:
        this.nextReconnectDelayMs = 0;
        socket.close();
        return;
      case 9:
        if (payload.d !== true) {
          this.clearSession();
          this.shouldInvalidateToken = true;
        }
        this.nextReconnectDelayMs = 3000;
        socket.close();
        return;
      case 11:
        return;
      default:
        return;
    }
  }

  private async handleHello(socket: WebSocket, payload: GatewayPayload): Promise<void> {
    const accessToken = this.currentAccessToken;
    if (!accessToken) {
      throw new Error("qq gateway access token not initialized");
    }

    const heartbeatInterval = this.readHeartbeatInterval(payload.d);
    if (heartbeatInterval === null) {
      throw new Error("qq gateway hello payload missing heartbeat interval");
    }

    if (this.currentSession) {
      socket.send(JSON.stringify({
        op: 6,
        d: {
          token: `QQBot ${accessToken}`,
          session_id: this.currentSession.sessionId,
          seq: this.currentSession.lastSeq
        }
      }));
    } else {
      socket.send(JSON.stringify({
        op: 2,
        d: {
          token: `QQBot ${accessToken}`,
          intents: QQ_GATEWAY_INTENTS,
          shard: [0, 1]
        }
      }));
    }

    this.startHeartbeat(heartbeatInterval);
  }

  private async handleDispatch(payload: GatewayPayload): Promise<void> {
    const dispatchData = this.readDispatchData(payload.d);

    if (payload.t === "READY") {
      const sessionId = typeof dispatchData?.session_id === "string" ? dispatchData.session_id : null;
      if (sessionId) {
        this.currentSession = {
          sessionId,
          lastSeq: payload.s ?? this.currentSession?.lastSeq ?? 0
        };
        this.config.sessionStore.save(this.currentSession);
      }
      return;
    }

    if (payload.t === "RESUMED") {
      if (this.currentSession) {
        this.config.sessionStore.save(this.currentSession);
      }
      return;
    }

    if (
      dispatchData
      && (
        payload.t === "C2C_MESSAGE_CREATE"
        || payload.t === "GROUP_AT_MESSAGE_CREATE"
        || payload.t === "GROUP_MESSAGE_CREATE"
      )
    ) {
      await this.gateway.dispatchPayload({
        t: payload.t,
        d: dispatchData
      } as never);
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        return;
      }

      this.socket.send(JSON.stringify({
        op: 1,
        d: this.currentSession?.lastSeq ?? null
      }));
    }, intervalMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private onSocketClosed(socket: WebSocket, code: number): void {
    if (this.socket !== socket) {
      return;
    }

    this.socket = null;
    this.clearHeartbeat();

    if (!this.started) {
      return;
    }

    let delay = this.nextReconnectDelayMs ?? this.reconnectDelaysMs[
      Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1)
    ];
    this.nextReconnectDelayMs = null;

    if (code === 4914 || code === 4915) {
      console.error("[qq-codex-bridge] qq gateway terminated permanently", { code });
      this.started = false;
      return;
    }

    if (code === 4004) {
      this.shouldInvalidateToken = true;
    } else if (code === 4008) {
      delay = RATE_LIMIT_DELAY_MS;
    } else if (
      code === 4006
      || code === 4007
      || code === 4009
      || (code >= 4900 && code <= 4913)
    ) {
      this.clearSession();
      this.shouldInvalidateToken = true;
    }

    this.scheduleReconnect(delay);
  }

  private scheduleReconnect(delayMs: number): void {
    if (!this.started || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempt += 1;
      void this.connect().catch((error) => {
        console.error("[qq-codex-bridge] qq gateway reconnect failed", { error });
        this.scheduleReconnect(this.reconnectDelaysMs[
          Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1)
        ]);
      });
    }, delayMs);
  }

  private updateLastSeq(lastSeq: number): void {
    if (!this.currentSession) {
      return;
    }

    this.currentSession = {
      ...this.currentSession,
      lastSeq
    };
    this.config.sessionStore.save(this.currentSession);
  }

  private clearSession(): void {
    this.currentSession = null;
    this.config.sessionStore.clear();
  }

  private readHeartbeatInterval(payload: unknown): number | null {
    if (!payload || typeof payload !== "object") {
      return null;
    }

    const value = (payload as { heartbeat_interval?: unknown }).heartbeat_interval;
    return typeof value === "number" ? value : null;
  }

  private readDispatchData(payload: unknown): Record<string, unknown> | null {
    if (!payload || typeof payload !== "object") {
      return null;
    }

    return payload as Record<string, unknown>;
  }
}
