import { existsSync, readFileSync } from "node:fs";
import { MediaArtifactKind, type MediaArtifact } from "../../../domain/src/message.js";

type FetchLike = typeof fetch;

type QqApiClientOptions = {
  authBaseUrl?: string;
  apiBaseUrl?: string;
  fetchFn?: FetchLike;
  now?: () => number;
  markdownSupport?: boolean;
};

type CachedToken = {
  value: string;
  expiresAt: number;
};

export class QqApiClient {
  private readonly authBaseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly markdownSupport: boolean;
  private cachedToken: CachedToken | null = null;
  private readonly msgSeqByReplyId = new Map<string, number>();

  constructor(
    readonly appId: string,
    readonly clientSecret: string,
    options: QqApiClientOptions = {}
  ) {
    this.authBaseUrl = options.authBaseUrl ?? "https://bots.qq.com";
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.sgroup.qq.com";
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
    this.markdownSupport = options.markdownSupport ?? false;
  }

  async getAccessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > this.now()) {
      return this.cachedToken.value;
    }

    const response = await this.fetchFn(`${this.authBaseUrl}/app/getAppAccessToken`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        appId: this.appId,
        clientSecret: this.clientSecret
      })
    });

    if (!response.ok) {
      throw new Error(`QQ auth failed: ${response.status}`);
    }

    const payload = (await response.json()) as {
      access_token?: string;
      expires_in?: number | string;
    };

    const expiresIn =
      typeof payload.expires_in === "number"
        ? payload.expires_in
        : typeof payload.expires_in === "string"
          ? Number(payload.expires_in)
          : Number.NaN;

    if (!payload.access_token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error("QQ auth response missing access token");
    }

    this.cachedToken = {
      value: payload.access_token,
      expiresAt: this.now() + Math.max(expiresIn - 60, 1) * 1000
    };

    return payload.access_token;
  }

  invalidateAccessToken(): void {
    this.cachedToken = null;
  }

  async getGatewayUrl(): Promise<string> {
    const accessToken = await this.getAccessToken();
    const response = await this.fetchFn(`${this.apiBaseUrl}/gateway`, {
      method: "GET",
      headers: {
        authorization: `QQBot ${accessToken}`,
        "content-type": "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`QQ gateway discovery failed: ${response.status}`);
    }

    const payload = (await response.json()) as { url?: string };
    if (!payload.url) {
      throw new Error("QQ gateway response missing websocket url");
    }

    return payload.url;
  }

  async sendC2CMessage(userOpenId: string, content: string, msgId: string): Promise<string | null> {
    return this.sendMessage(`/v2/users/${encodeURIComponent(userOpenId)}/messages`, content, msgId);
  }

  async sendGroupMessage(groupOpenId: string, content: string, msgId: string): Promise<string | null> {
    return this.sendMessage(`/v2/groups/${encodeURIComponent(groupOpenId)}/messages`, content, msgId);
  }

  async sendC2CMediaArtifact(
    userOpenId: string,
    artifact: MediaArtifact,
    msgId: string,
    content?: string
  ): Promise<string | null> {
    return this.sendMediaArtifact(`/v2/users/${encodeURIComponent(userOpenId)}`, artifact, msgId, content);
  }

  async sendGroupMediaArtifact(
    groupOpenId: string,
    artifact: MediaArtifact,
    msgId: string,
    content?: string
  ): Promise<string | null> {
    return this.sendMediaArtifact(`/v2/groups/${encodeURIComponent(groupOpenId)}`, artifact, msgId, content);
  }

  private async sendMessage(
    path: string,
    content: string,
    msgId: string
  ): Promise<string | null> {
    const accessToken = await this.getAccessToken();
    const response = await this.fetchFn(`${this.apiBaseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `QQBot ${accessToken}`,
        "content-type": "application/json",
        "X-Union-Appid": this.appId
      },
      body: JSON.stringify(this.buildMessageBody(content, msgId))
    });

    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      throw new Error(`QQ message send failed: ${response.status}${responseText ? ` ${responseText}` : ""}`);
    }

    const payload = (await response.json()) as { id?: string };
    return payload.id ?? null;
  }

  private async sendMediaArtifact(
    pathPrefix: string,
    artifact: MediaArtifact,
    msgId: string,
    content?: string
  ): Promise<string | null> {
    const accessToken = await this.getAccessToken();
    const uploadBody = await this.buildMediaUploadBody(artifact);
    const uploadResponse = await this.fetchFn(`${this.apiBaseUrl}${pathPrefix}/files`, {
      method: "POST",
      headers: {
        authorization: `QQBot ${accessToken}`,
        "content-type": "application/json",
        "X-Union-Appid": this.appId
      },
      body: JSON.stringify({
        ...uploadBody,
        file_type: this.mapMediaFileType(artifact.kind),
        srv_send_msg: false,
        ...(artifact.kind === MediaArtifactKind.File ? { file_name: artifact.originalName } : {})
      })
    });

    if (!uploadResponse.ok) {
      const responseText = await uploadResponse.text().catch(() => "");
      throw new Error(`QQ media upload failed: ${uploadResponse.status}${responseText ? ` ${responseText}` : ""}`);
    }

    const uploadPayload = (await uploadResponse.json()) as { file_info?: string };
    if (!uploadPayload.file_info) {
      throw new Error("QQ media upload response missing file_info");
    }

    const response = await this.fetchFn(`${this.apiBaseUrl}${pathPrefix}/messages`, {
      method: "POST",
      headers: {
        authorization: `QQBot ${accessToken}`,
        "content-type": "application/json",
        "X-Union-Appid": this.appId
      },
      body: JSON.stringify({
        msg_type: 7,
        media: { file_info: uploadPayload.file_info },
        msg_seq: this.nextMsgSeq(msgId),
        msg_id: msgId,
        ...(content ? { content } : {})
      })
    });

    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      throw new Error(`QQ media message send failed: ${response.status}${responseText ? ` ${responseText}` : ""}`);
    }

    const payload = (await response.json()) as { id?: string };
    return payload.id ?? null;
  }

  private nextMsgSeq(msgId: string): number {
    const next = (this.msgSeqByReplyId.get(msgId) ?? 0) + 1;
    this.msgSeqByReplyId.set(msgId, next);
    return next;
  }

  private buildMessageBody(content: string, msgId: string): Record<string, unknown> {
    const msgSeq = this.nextMsgSeq(msgId);

    if (this.markdownSupport) {
      return {
        markdown: { content },
        msg_type: 2,
        msg_seq: msgSeq,
        msg_id: msgId
      };
    }

    return {
      content,
      msg_type: 0,
      msg_seq: msgSeq,
      msg_id: msgId
    };
  }

  private async buildMediaUploadBody(artifact: MediaArtifact): Promise<Record<string, unknown>> {
    if (artifact.sourceUrl.startsWith("http://") || artifact.sourceUrl.startsWith("https://")) {
      return { url: artifact.sourceUrl };
    }

    if (existsSync(artifact.localPath)) {
      return { file_data: readFileSync(artifact.localPath).toString("base64") };
    }

    throw new Error(`QQ media source not found: ${artifact.localPath}`);
  }

  private mapMediaFileType(kind: MediaArtifactKind): number {
    switch (kind) {
      case MediaArtifactKind.Image:
        return 1;
      case MediaArtifactKind.Video:
        return 2;
      case MediaArtifactKind.Audio:
        return 3;
      case MediaArtifactKind.File:
      default:
        return 4;
    }
  }
}
