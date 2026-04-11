import { describe, expect, it, vi } from "vitest";
import { MediaArtifactKind } from "../../packages/domain/src/message.js";
import { QqApiClient } from "../../packages/adapters/qq/src/qq-api-client.js";

describe("qq api client", () => {
  it("fetches and caches the app access token", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "token-1", expires_in: "3600" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const now = vi.fn(() => 1_000);
    const client = new QqApiClient("app-id", "secret", {
      fetchFn,
      now,
      authBaseUrl: "https://bots.qq.com"
    });

    await expect(client.getAccessToken()).resolves.toBe("token-1");
    await expect(client.getAccessToken()).resolves.toBe("token-1");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://bots.qq.com/app/getAppAccessToken",
      expect.objectContaining({
        method: "POST"
      })
    );
  });

  it("fetches the websocket gateway url with bot authorization", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "token-1", expires_in: "3600" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ url: "wss://gateway.qq.example/ws" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );

    const client = new QqApiClient("app-id", "secret", {
      fetchFn,
      now: () => 1_000,
      authBaseUrl: "https://bots.qq.com",
      apiBaseUrl: "https://api.sgroup.qq.com"
    });

    await expect(client.getGatewayUrl()).resolves.toBe("wss://gateway.qq.example/ws");
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      "https://api.sgroup.qq.com/gateway",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "QQBot token-1"
        })
      })
    );
  });

  it("sends c2c replies with qq passive plain text fields by default", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "token-1", expires_in: "3600" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "qq-msg-1" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );

    const client = new QqApiClient("app-id", "secret", {
      fetchFn,
      now: () => 1_000,
      authBaseUrl: "https://bots.qq.com",
      apiBaseUrl: "https://api.sgroup.qq.com"
    });

    await expect(client.sendC2CMessage("OPENID123", "hello", "qq-inbound-1")).resolves.toBe("qq-msg-1");
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      "https://api.sgroup.qq.com/v2/users/OPENID123/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          content: "hello",
          msg_type: 0,
          msg_seq: 1,
          msg_id: "qq-inbound-1"
        })
      })
    );
  });

  it("can opt into markdown payloads when markdown support is enabled", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "token-1", expires_in: "3600" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "qq-msg-2" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );

    const client = new QqApiClient("app-id", "secret", {
      fetchFn,
      now: () => 1_000,
      authBaseUrl: "https://bots.qq.com",
      apiBaseUrl: "https://api.sgroup.qq.com",
      markdownSupport: true
    });

    await expect(client.sendC2CMessage("OPENID123", "hello", "qq-inbound-2")).resolves.toBe("qq-msg-2");
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      "https://api.sgroup.qq.com/v2/users/OPENID123/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          markdown: { content: "hello" },
          msg_type: 2,
          msg_seq: 1,
          msg_id: "qq-inbound-2"
        })
      })
    );
  });

  it("can opt into markdown payloads per message for rich formatted content", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "token-1", expires_in: "3600" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "qq-msg-3" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );

    const client = new QqApiClient("app-id", "secret", {
      fetchFn,
      now: () => 1_000,
      authBaseUrl: "https://bots.qq.com",
      apiBaseUrl: "https://api.sgroup.qq.com",
      markdownSupport: false
    });

    await expect(
      client.sendC2CMessage("OPENID123", "```js\nconst x = 1;\n```", "qq-inbound-2b", {
        preferMarkdown: true
      })
    ).resolves.toBe("qq-msg-3");

    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      "https://api.sgroup.qq.com/v2/users/OPENID123/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          markdown: { content: "```js\nconst x = 1;\n```" },
          msg_type: 2,
          msg_seq: 1,
          msg_id: "qq-inbound-2b"
        })
      })
    );
  });

  it("uploads and sends a c2c media artifact through qq media endpoints", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "token-1", expires_in: "3600" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ file_info: "file-info-1" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "qq-media-msg-1" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );

    const client = new QqApiClient("app-id", "secret", {
      fetchFn,
      now: () => 1_000,
      authBaseUrl: "https://bots.qq.com",
      apiBaseUrl: "https://api.sgroup.qq.com"
    });

    await expect(
      client.sendC2CMediaArtifact(
        "OPENID123",
        {
          kind: MediaArtifactKind.Image,
          sourceUrl: "https://example.com/cat.png",
          localPath: "https://example.com/cat.png",
          mimeType: "image/png",
          fileSize: 2048,
          originalName: "cat.png"
        },
        "qq-inbound-3"
      )
    ).resolves.toBe("qq-media-msg-1");

    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      "https://api.sgroup.qq.com/v2/users/OPENID123/files",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          url: "https://example.com/cat.png",
          file_type: 1,
          srv_send_msg: false
        })
      })
    );

    expect(fetchFn).toHaveBeenNthCalledWith(
      3,
      "https://api.sgroup.qq.com/v2/users/OPENID123/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          msg_type: 7,
          media: { file_info: "file-info-1" },
          msg_seq: 1,
          msg_id: "qq-inbound-3"
        })
      })
    );
  });
});
