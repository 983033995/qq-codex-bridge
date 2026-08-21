import { createHash } from "node:crypto";
import path from "node:path";
import {
  createQqChannelAdapter
} from "../../../packages/adapters/qq/src/qq-channel-adapter.js";
import { QqApiClient } from "../../../packages/adapters/qq/src/qq-api-client.js";
import { FileQqGatewaySessionStore } from "../../../packages/adapters/qq/src/qq-gateway-session-store.js";
import {
  MediaArtifactKind,
  type DeliveryRecord,
  type InboundMessage,
  type MediaArtifact,
  type OutboundDraft
} from "../../../packages/domain/src/message.js";
import type { Attachment, ComponentHealth } from "../../../packages/domain/src/vnext/index.js";
import type { SecretStorePort } from "../../../packages/ports/src/vnext/index.js";
import type { ControlDaemonComponent } from "./composition-root.js";

type QqRuntimeAdapter = {
  ingress: {
    onMessage(handler: (message: InboundMessage) => Promise<void>): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
  };
  egress: {
    deliver(draft: OutboundDraft): Promise<DeliveryRecord>;
  };
};

type QqRuntimeConnection = {
  adapter: QqRuntimeAdapter;
  test(): Promise<void>;
};

type QqRuntimeAdapterFactory = (input: {
  accountId: string;
  appId: string;
  secret: string;
  dataDirectory: string;
}) => QqRuntimeConnection;

export type QqRuntimeInbound = {
  accountId: string;
  providerMessageId: string;
  peerId: string;
  chatType: "c2c" | "group";
  senderId: string;
  text: string;
  replyToMessageId?: string;
  attachments: Attachment[];
  sequence: number;
  receivedAt: string;
};

export class QqAccountRuntime implements ControlDaemonComponent {
  readonly name: string;
  readonly critical = false;
  private readonly createConnection: QqRuntimeAdapterFactory;
  private readonly since = new Date().toISOString();
  private connection: QqRuntimeConnection | null = null;
  private state: "idle" | "starting" | "ready" | "degraded" | "stopped" = "idle";
  private lastError: string | null = null;
  private lastSuccessAt: string | null = null;
  private sequence = 0;

  constructor(private readonly options: {
    accountId: string;
    appId: string;
    secretRef: string;
    dataDirectory: string;
    secrets: SecretStorePort;
    onInbound(message: QqRuntimeInbound): Promise<void>;
    onError?(error: Error): void;
    createConnection?: QqRuntimeAdapterFactory;
  }) {
    this.name = `channel:qq:${options.accountId}`;
    this.createConnection = options.createConnection ?? createDefaultConnection;
  }

  async start(): Promise<void> {
    if (this.state === "ready" || this.state === "starting") return;
    this.state = "starting";
    try {
      const secret = await this.requiredSecret();
      const connection = this.createConnection({
        accountId: this.options.accountId,
        appId: this.options.appId,
        secret,
        dataDirectory: this.options.dataDirectory
      });
      await connection.test();
      await connection.adapter.ingress.onMessage((message) => this.acceptInbound(message));
      await connection.adapter.ingress.start();
      this.connection = connection;
      this.state = "ready";
      this.lastError = null;
      this.lastSuccessAt = new Date().toISOString();
    } catch (error) {
      this.connection = null;
      this.state = "degraded";
      this.recordError(normalizeError(error));
    }
  }

  async stop(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    if (connection) await connection.adapter.ingress.stop();
    this.state = "stopped";
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
    if (this.state !== "ready") {
      throw new Error(this.lastError ?? "QQ runtime failed to restart");
    }
  }

  async health(): Promise<ComponentHealth> {
    if (this.state === "ready") {
      return {
        component: this.name,
        status: "ready",
        message: "QQ 凭据有效，Gateway 长连接已启动",
        since: this.since,
        ...(this.lastSuccessAt ? { lastSuccessAt: this.lastSuccessAt } : {})
      };
    }
    return {
      component: this.name,
      status: this.state === "idle" || this.state === "stopped" ? "offline" : "degraded",
      code: "QQ_RUNTIME_NOT_READY",
      message: this.lastError ?? `QQ 运行时状态：${this.state}`,
      since: this.since,
      suggestedAction: "在管理台运行 QQ 渠道测试，检查 AppID、ClientSecret 和机器人权限"
    };
  }

  async test(): Promise<{ ok: true; message: string }> {
    const connection = this.connection ?? this.createConnection({
      accountId: this.options.accountId,
      appId: this.options.appId,
      secret: await this.requiredSecret(),
      dataDirectory: this.options.dataDirectory
    });
    await connection.test();
    this.lastError = null;
    this.lastSuccessAt = new Date().toISOString();
    return {
      ok: true,
      message: this.state === "ready"
        ? "QQ 凭据、机器人 API 与 Gateway 长连接均正常"
        : "QQ 凭据和机器人 API 正常，但 Gateway 长连接尚未就绪"
    };
  }

  async deliver(input: {
    deliveryKey: string;
    accountId: string;
    peerId: string;
    chatType: "c2c" | "group";
    text: string;
    attachments?: Attachment[];
    replyToProviderMessageId?: string;
  }): Promise<string | null> {
    if (input.accountId !== `qq:${this.options.accountId}`) {
      throw new Error(`QQ account '${input.accountId}' is not handled by ${this.name}`);
    }
    if (!this.connection || this.state !== "ready") {
      throw new Error(`QQ runtime '${input.accountId}' is not ready`);
    }
    const delivered = await this.connection.adapter.egress.deliver({
      draftId: qqStableId(input.deliveryKey),
      sessionKey: `${input.accountId}::qq:${input.chatType}:${input.peerId}`,
      text: input.text,
      mediaArtifacts: (input.attachments ?? []).map(toMediaArtifact),
      createdAt: new Date().toISOString(),
      ...(input.replyToProviderMessageId
        ? { replyToMessageId: input.replyToProviderMessageId }
        : {})
    });
    this.lastSuccessAt = new Date().toISOString();
    return delivered.providerMessageId;
  }

  private async acceptInbound(message: InboundMessage): Promise<void> {
    this.sequence += 1;
    this.lastSuccessAt = new Date().toISOString();
    await this.options.onInbound({
      accountId: `qq:${this.options.accountId}`,
      providerMessageId: message.messageId,
      peerId: peerId(message),
      chatType: message.chatType,
      senderId: message.senderId,
      text: message.text,
      ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
      attachments: (message.mediaArtifacts ?? []).map(toAttachment),
      sequence: this.sequence,
      receivedAt: message.receivedAt
    });
  }

  private async requiredSecret(): Promise<string> {
    const secret = await this.options.secrets.get(this.options.secretRef);
    if (!secret) throw new Error(`QQ Secret '${this.options.secretRef}' 不存在`);
    return secret;
  }

  private recordError(error: Error): void {
    this.lastError = error.message;
    this.options.onError?.(error);
  }
}

function createDefaultConnection(input: {
  accountId: string;
  appId: string;
  secret: string;
  dataDirectory: string;
}): QqRuntimeConnection {
  const accountKey = `qq:${input.accountId}`;
  const api = new QqApiClient(input.appId, input.secret);
  const adapter = createQqChannelAdapter({
    accountKey,
    appId: input.appId,
    apiClient: api,
    sessionStore: new FileQqGatewaySessionStore(
      path.join(input.dataDirectory, `qq-gateway-session-${safePathSegment(input.accountId)}.json`),
      accountKey,
      input.appId
    ),
    mediaDownloadDir: path.join(input.dataDirectory, "media", "qq", safePathSegment(input.accountId))
  });
  return { adapter, test: () => api.getAccessToken().then(() => undefined) };
}

function peerId(message: InboundMessage): string {
  const prefix = `qq:${message.chatType}:`;
  return message.peerKey.startsWith(prefix) ? message.peerKey.slice(prefix.length) : message.peerKey;
}

function toAttachment(artifact: MediaArtifact): Attachment {
  return {
    id: qqStableId([artifact.kind, artifact.localPath, artifact.sourceUrl].join(":")),
    kind: artifact.kind,
    localPath: artifact.localPath,
    mimeType: artifact.mimeType,
    size: artifact.fileSize,
    name: artifact.originalName,
    ...(artifact.transcript ? { transcript: artifact.transcript } : {})
  };
}

function toMediaArtifact(attachment: Attachment): MediaArtifact {
  return {
    kind: mediaKind(attachment.kind),
    sourceUrl: attachment.localPath,
    localPath: attachment.localPath,
    mimeType: attachment.mimeType,
    fileSize: attachment.size,
    originalName: attachment.name ?? path.basename(attachment.localPath),
    ...(attachment.transcript ? { transcript: attachment.transcript } : {})
  };
}

function mediaKind(kind: Attachment["kind"]): MediaArtifactKind {
  return {
    image: MediaArtifactKind.Image,
    audio: MediaArtifactKind.Audio,
    video: MediaArtifactKind.Video,
    file: MediaArtifactKind.File
  }[kind];
}

function qqStableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
