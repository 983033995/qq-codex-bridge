import type { MediaArtifact } from "../../../domain/src/message.js";

type FetchLike = typeof fetch;

type WeixinHttpClientOptions = {
  fetchFn?: FetchLike;
};

export class WeixinHttpClient {
  private readonly fetchFn: FetchLike;

  constructor(
    readonly baseUrl: string,
    readonly token: string,
    options: WeixinHttpClientOptions = {}
  ) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async sendTextMessage(target: {
    peerId: string;
    chatType: "c2c" | "group";
    replyToMessageId?: string;
    content: string;
  }): Promise<string | null> {
    return this.sendMessage({
      peerId: target.peerId,
      chatType: target.chatType,
      content: target.content,
      ...(target.replyToMessageId ? { replyToMessageId: target.replyToMessageId } : {})
    });
  }

  async sendMessage(target: {
    peerId: string;
    chatType: "c2c" | "group";
    replyToMessageId?: string;
    content?: string;
    mediaArtifacts?: MediaArtifact[];
  }): Promise<string | null> {
    const response = await this.fetchFn(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        peerId: target.peerId,
        chatType: target.chatType,
        ...(target.content ? { content: target.content } : {}),
        ...(target.mediaArtifacts?.length ? { mediaArtifacts: target.mediaArtifacts } : {}),
        ...(target.replyToMessageId ? { replyToMessageId: target.replyToMessageId } : {})
      })
    });

    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      throw new Error(
        `Weixin message send failed: ${response.status}${responseText ? ` ${responseText}` : ""}`
      );
    }

    const payload = (await response.json().catch(() => ({}))) as { id?: string };
    return payload.id ?? null;
  }
}
