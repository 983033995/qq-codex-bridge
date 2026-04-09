type FetchLike = typeof fetch;

type QqApiClientOptions = {
  authBaseUrl?: string;
  apiBaseUrl?: string;
  fetchFn?: FetchLike;
  now?: () => number;
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
  private cachedToken: CachedToken | null = null;

  constructor(
    readonly appId: string,
    readonly clientSecret: string,
    options: QqApiClientOptions = {}
  ) {
    this.authBaseUrl = options.authBaseUrl ?? "https://bots.qq.com";
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.sgroup.qq.com";
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
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
      expires_in?: number;
    };

    if (!payload.access_token || typeof payload.expires_in !== "number") {
      throw new Error("QQ auth response missing access token");
    }

    this.cachedToken = {
      value: payload.access_token,
      expiresAt: this.now() + Math.max(payload.expires_in - 60, 1) * 1000
    };

    return payload.access_token;
  }

  async sendC2CMessage(userOpenId: string, content: string, msgId: string): Promise<string | null> {
    return this.sendMessage(`/v2/users/${encodeURIComponent(userOpenId)}/messages`, content, msgId);
  }

  async sendGroupMessage(groupOpenId: string, content: string, msgId: string): Promise<string | null> {
    return this.sendMessage(`/v2/groups/${encodeURIComponent(groupOpenId)}/messages`, content, msgId);
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
      body: JSON.stringify({
        content,
        msg_id: msgId
      })
    });

    if (!response.ok) {
      throw new Error(`QQ message send failed: ${response.status}`);
    }

    const payload = (await response.json()) as { id?: string };
    return payload.id ?? null;
  }
}
