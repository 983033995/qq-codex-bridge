import { createCipheriv } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WeixinMessageClient,
  extractWeixinText,
  normalizeInboundText,
  splitWeixinTextContent,
  type WeixinMessageState
} from "../../packages/channel-weixin/src/index.js";

describe("vNext Weixin message client", () => {
  it("polls text and voice transcripts, advances the cursor, and ignores outbound echoes", async () => {
    const state = new MemoryMessageState();
    const received: unknown[] = [];
    let request: RequestInit | undefined;
    const fetchFn: typeof fetch = async (_url, init) => {
      request = init;
      return new Response(JSON.stringify({
        ret: 0,
        get_updates_buf: "cursor-2",
        msgs: [
          rawMessage("message-1", 1, { type: 1, text_item: { text: "你好" } }, "context-1"),
          rawMessage("message-2", 2, { type: 3, voice_item: { text: "语音转写" } }),
          { ...rawMessage("message-3", 3, { type: 1, text_item: { text: "echo" } }), message_type: 2 },
          rawMessage("message-4", 4, { type: 2 })
        ]
      }), { status: 200 });
    };
    const client = new WeixinMessageClient({
      accountId: "weixin:personal",
      credential: { token: "secret-token", baseUrl: "http://127.0.0.1:9090" },
      state,
      fetchFn,
      now: () => new Date("2026-08-11T04:00:00.000Z"),
      onMessage: async (message) => { received.push(message); }
    });

    await expect(client.pollOnce()).resolves.toBe(3);
    expect(state.getCursor("weixin:personal")).toBe("cursor-2");
    expect(state.getContextToken("weixin:personal", "user-1")).toBe("context-1");
    expect(received).toEqual([
      expect.objectContaining({ providerMessageId: "message-1", sequence: 1, text: "你好", peerId: "user-1" }),
      expect.objectContaining({ providerMessageId: "message-2", sequence: 2, text: "语音转写" }),
      expect.objectContaining({ providerMessageId: "message-4", text: expect.stringContaining("未提供可下载") })
    ]);
    if (!request) throw new Error("expected Weixin poll request");
    expect(JSON.parse(String(request.body))).toMatchObject({ get_updates_buf: "" });
    expect(request.headers).toMatchObject({ Authorization: "Bearer secret-token" });
  });

  it("delivers text with the remembered context token and never exposes response bodies in errors", async () => {
    const state = new MemoryMessageState();
    await state.setContextToken("weixin:personal", "user-1", "context-1");
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let fail = false;
    const client = new WeixinMessageClient({
      accountId: "weixin:personal",
      credential: { token: "secret-token", baseUrl: "http://127.0.0.1:9090" },
      state,
      fetchFn: async (url, init) => {
        requests.push({ url: String(url), init });
        return fail
          ? new Response("sensitive-provider-body", { status: 500 })
          : new Response(JSON.stringify({ ret: 0 }), { status: 200 });
      },
      onMessage: async () => undefined
    });

    await expect(client.deliver({ deliveryKey: "delivery-1", accountId: "weixin:personal", peerId: "user-1", chatType: "c2c", text: "回复" }))
      .resolves.toBe("delivery-1");
    const payload = JSON.parse(String(requests[0]!.init?.body));
    expect(payload.msg).toMatchObject({
      to_user_id: "user-1",
      client_id: "delivery-1",
      context_token: "context-1",
      item_list: [{ type: 1, text_item: { text: "回复" } }]
    });
    fail = true;
    const error: unknown = await client.deliver({ deliveryKey: "delivery-2", accountId: "weixin:personal", peerId: "user-1", chatType: "c2c", text: "再试" })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("expected Weixin delivery to fail");
    expect(error.message).toContain("HTTP 500");
    expect(error.message).not.toContain("sensitive-provider-body");
  });

  it("does not advance the cursor when inbound IPC delivery fails", async () => {
    const state = new MemoryMessageState();
    const client = new WeixinMessageClient({
      accountId: "weixin:personal",
      credential: { token: "secret-token", baseUrl: "http://127.0.0.1:9090" },
      state,
      fetchFn: async () => new Response(JSON.stringify({
        ret: 0,
        get_updates_buf: "cursor-after-failure",
        msgs: [rawMessage("message-failure", 1, { type: 1, text_item: { text: "retry me" } })]
      }), { status: 200 }),
      onMessage: async () => { throw new Error("IPC disconnected"); }
    });

    await expect(client.pollOnce()).rejects.toThrow("IPC disconnected");
    expect(state.getCursor("weixin:personal")).toBe("");
  });

  it("waits for the application ACK before advancing the cursor", async () => {
    const state = new MemoryMessageState();
    let acknowledge: (() => void) | undefined;
    const acknowledged = new Promise<void>((resolve) => { acknowledge = resolve; });
    const client = new WeixinMessageClient({
      accountId: "weixin:personal",
      credential: { token: "secret-token", baseUrl: "http://127.0.0.1:9090" },
      state,
      fetchFn: async () => new Response(JSON.stringify({
        ret: 0,
        get_updates_buf: "cursor-after-ack",
        msgs: [rawMessage("message-ack", 1, { type: 1, text_item: { text: "persist me" } })]
      }), { status: 200 }),
      onMessage: async () => acknowledged
    });

    const polling = client.pollOnce();
    await eventually(() => acknowledge !== undefined);
    expect(state.getCursor("weixin:personal")).toBe("");
    acknowledge!();
    await expect(polling).resolves.toBe(1);
    expect(state.getCursor("weixin:personal")).toBe("cursor-after-ack");
  });

  it("redelivers after a crash between ACK and cursor persistence", async () => {
    let cursor = "";
    let failCursorWrite = true;
    const state: WeixinMessageState = {
      getCursor: () => cursor,
      async setCursor(_accountId, value) {
        if (failCursorWrite) {
          failCursorWrite = false;
          throw new Error("worker crashed before cursor fsync");
        }
        cursor = value;
      },
      getContextToken: () => "",
      setContextToken: async () => undefined
    };
    let applications = 0;
    const client = new WeixinMessageClient({
      accountId: "weixin:personal",
      credential: { token: "secret-token", baseUrl: "http://127.0.0.1:9090" },
      state,
      fetchFn: async () => new Response(JSON.stringify({
        ret: 0,
        get_updates_buf: "cursor-after-restart",
        msgs: [rawMessage("message-crash-window", 1, { type: 1, text_item: { text: "dedupe me" } })]
      }), { status: 200 }),
      onMessage: async () => { applications += 1; }
    });

    await expect(client.pollOnce()).rejects.toThrow("worker crashed before cursor fsync");
    expect(cursor).toBe("");
    await expect(client.pollOnce()).resolves.toBe(1);
    expect(applications).toBe(2);
    expect(cursor).toBe("cursor-after-restart");
  });

  it("normalizes stable fallback ids and rejects unsafe endpoints", () => {
    expect(extractWeixinText(rawMessage("id", 1, { type: 1, text_item: { text: " text " } }))).toBe("text");
    expect(normalizeInboundText("weixin:personal", {
      from_user_id: "user-1",
      seq: 9,
      item_list: [{ type: 1, text_item: { text: "hello" } }]
    }, () => new Date("2026-08-11T04:00:00.000Z"))).toMatchObject({
      providerMessageId: "user-1:9",
      receivedAt: "2026-08-11T04:00:00.000Z"
    });
    expect(() => new WeixinMessageClient({
      accountId: "weixin:personal",
      credential: { token: "token", baseUrl: "http://example.com" },
      state: new MemoryMessageState(),
      onMessage: async () => undefined
    })).toThrow("must use HTTPS");
  });

  it("downloads, decrypts, and securely caches inbound image/file/voice attachments", async () => {
    const mediaDirectoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "vnext-weixin-inbound-media-"));
    const fixtures = [
      mediaFixture("image", Buffer.from("image-bytes")),
      mediaFixture("file", Buffer.from("file-bytes")),
      mediaFixture("voice", Buffer.from("voice-bytes"))
    ];
    const requests: string[] = [];
    let mediaIndex = 0;
    const received: unknown[] = [];
    const client = new WeixinMessageClient({
      accountId: "weixin:personal",
      credential: { token: "secret-token", baseUrl: "http://127.0.0.1:9090" },
      state: new MemoryMessageState(),
      mediaDirectoryPath,
      fetchFn: async (url) => {
        requests.push(String(url));
        if (String(url).includes("getupdates")) {
          return new Response(JSON.stringify({
            ret: 0,
            get_updates_buf: "cursor-media",
            msgs: [{
              from_user_id: "user-media",
              message_id: "message-media",
              seq: 7,
              item_list: [
                {
                  type: 2,
                  image_item: {
                    media: fixtures[0]!.media,
                    mid_size: fixtures[0]!.plaintext.length
                  }
                },
                {
                  type: 4,
                  file_item: {
                    media: fixtures[1]!.media,
                    file_name: "notes.txt",
                    len: String(fixtures[1]!.plaintext.length)
                  }
                },
                {
                  type: 3,
                  voice_item: {
                    media: fixtures[2]!.media,
                    size: fixtures[2]!.plaintext.length,
                    text: "语音转写"
                  }
                }
              ]
            }]
          }), { status: 200 });
        }
        const fixture = fixtures[mediaIndex++]!;
        return new Response(new Uint8Array(fixture.encrypted), {
          status: 200,
          headers: { "content-length": String(fixture.encrypted.length) }
        });
      },
      onMessage: async (message) => { received.push(message); }
    });

    await expect(client.pollOnce()).resolves.toBe(1);
    expect(requests.slice(1)).toEqual([
      expect.stringContaining("/c2c/download?encrypted_query_param=image"),
      expect.stringContaining("/c2c/download?encrypted_query_param=file"),
      expect.stringContaining("/c2c/download?encrypted_query_param=voice")
    ]);
    const message = received[0] as {
      text: string;
      attachments: Array<{ kind: string; localPath: string; transcript?: string }>;
    };
    expect(message.text).toBe("语音转写");
    expect(message.attachments.map((attachment) => attachment.kind)).toEqual(["image", "file", "audio"]);
    expect(message.attachments[2]?.transcript).toBe("语音转写");
    expect(fs.readFileSync(message.attachments[0]!.localPath)).toEqual(fixtures[0]!.plaintext);
    expect(fs.readFileSync(message.attachments[1]!.localPath)).toEqual(fixtures[1]!.plaintext);
    expect(fs.readFileSync(message.attachments[2]!.localPath)).toEqual(fixtures[2]!.plaintext);
    expect(fs.statSync(message.attachments[0]!.localPath).mode & 0o777).toBe(0o600);
  });

  it("keeps inbound text when one media download fails and reports a safe fallback", async () => {
    const errors: Error[] = [];
    const received: Array<{ text: string; attachments: unknown[] }> = [];
    const state = new MemoryMessageState();
    const client = new WeixinMessageClient({
      accountId: "weixin:personal",
      credential: { token: "secret-token", baseUrl: "http://127.0.0.1:9090" },
      state,
      fetchFn: async (url) => String(url).includes("getupdates")
        ? new Response(JSON.stringify({
            ret: 0,
            get_updates_buf: "cursor-after-media-failure",
            msgs: [{
              from_user_id: "user-1",
              message_id: "message-with-text",
              seq: 8,
              item_list: [
                { type: 1, text_item: { text: "请先处理正文" } },
                { type: 2, image_item: { media: { encrypt_query_param: "failed", aes_key: "bad", encrypt_type: 1 } } }
              ]
            }]
          }), { status: 200 })
        : new Response("sensitive-cdn-body", { status: 503 }),
      onError: (error) => { errors.push(error); },
      onMessage: async (message) => { received.push(message); }
    });

    await expect(client.pollOnce()).resolves.toBe(1);
    expect(state.getCursor("weixin:personal")).toBe("cursor-after-media-failure");
    expect(received[0]).toMatchObject({ attachments: [], text: expect.stringContaining("请先处理正文") });
    expect(received[0]!.text).toContain("图片");
    expect(received[0]!.text).not.toContain("sensitive-cdn-body");
    expect(errors[0]?.message).toBe("media download HTTP 503");
  });

  it("uploads outbound image/file/audio media and uses stable client ids", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vnext-weixin-outbound-media-"));
    const attachments = [
      localAttachment(root, "image", "image.jpg", "image/jpeg", Buffer.from("image")),
      localAttachment(root, "file", "notes.txt", "text/plain", Buffer.from("notes")),
      localAttachment(root, "audio", "voice.mp3", "audio/mpeg", Buffer.from("audio"))
    ] as const;
    const sendBodies: Array<Record<string, any>> = [];
    const uploadBodies: Uint8Array[] = [];
    let uploadIndex = 0;
    const client = new WeixinMessageClient({
      accountId: "weixin:personal",
      credential: { token: "secret-token", baseUrl: "http://127.0.0.1:9090" },
      state: new MemoryMessageState(),
      fetchFn: async (url, init) => {
        const value = String(url);
        if (value.includes("getuploadurl")) {
          uploadIndex += 1;
          return new Response(JSON.stringify({ ret: 0, upload_param: `upload-${uploadIndex}` }), { status: 200 });
        }
        if (value.includes("/c2c/upload")) {
          uploadBodies.push(init!.body as Uint8Array);
          return new Response("", {
            status: 200,
            headers: { "x-encrypted-param": `cdn-${uploadBodies.length}` }
          });
        }
        sendBodies.push(JSON.parse(String(init?.body)) as Record<string, any>);
        return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
      },
      onMessage: async () => undefined
    });

    await expect(client.deliver({
      deliveryKey: "delivery-media",
      accountId: "weixin:personal",
      peerId: "user-1",
      chatType: "c2c",
      text: "",
      attachments: [...attachments]
    })).resolves.toBe("delivery-media:media:3");
    expect(sendBodies.map((body) => body.msg.client_id)).toEqual([
      "delivery-media:media:1",
      "delivery-media:media:2",
      "delivery-media:media:3"
    ]);
    expect(sendBodies.map((body) => body.msg.item_list[0].type)).toEqual([2, 4, 4]);
    expect(sendBodies[2]!.msg.item_list[0].file_item.file_name).toBe("voice.mp3");
    expect(Buffer.from(uploadBodies[0]!)).not.toEqual(Buffer.from("image"));
  });

  it("splits long Unicode text at 1800 code points with stable idempotency keys", async () => {
    const text = `${"你".repeat(1_799)}🙂再见`;
    expect(splitWeixinTextContent(text).map((segment) => Array.from(segment).length)).toEqual([1_800, 2]);
    const ids: string[] = [];
    const client = new WeixinMessageClient({
      accountId: "weixin:personal",
      credential: { token: "secret-token", baseUrl: "http://127.0.0.1:9090" },
      state: new MemoryMessageState(),
      fetchFn: async (_url, init) => {
        ids.push(JSON.parse(String(init?.body)).msg.client_id as string);
        return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
      },
      onMessage: async () => undefined
    });

    await client.deliver({
      deliveryKey: "delivery-long",
      accountId: "weixin:personal",
      peerId: "user-1",
      chatType: "c2c",
      text
    });
    expect(ids).toEqual(["delivery-long:text:1", "delivery-long:text:2"]);
  });

  it("honors Retry-After, exponentially backs off, and stops retrying invalid credentials", async () => {
    const delays: number[] = [];
    const errors: Error[] = [];
    let calls = 0;
    const client = new WeixinMessageClient({
      accountId: "weixin:personal",
      credential: { token: "secret-token", baseUrl: "http://127.0.0.1:9090" },
      state: new MemoryMessageState(),
      retryDelayMs: 10,
      fetchFn: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("rate-limit-body", { status: 429, headers: { "retry-after": "5" } });
        }
        if (calls === 2) return new Response("server-body", { status: 503 });
        return new Response("auth-body", { status: 401 });
      },
      sleep: async (durationMs) => { delays.push(durationMs); },
      onError: (error) => { errors.push(error); },
      onMessage: async () => undefined
    });

    client.start();
    await eventually(() => calls === 3);
    await client.stop();
    expect(delays).toEqual([5_000, 20]);
    expect(errors.map((error) => error.message)).toEqual([
      "Weixin message rate limited: HTTP 429",
      "Weixin message HTTP 503",
      "Weixin message authentication failed: HTTP 401"
    ]);
    expect(JSON.stringify(errors)).not.toContain("rate-limit-body");
    expect(JSON.stringify(errors)).not.toContain("auth-body");
  });
});

class MemoryMessageState implements WeixinMessageState {
  private readonly cursors = new Map<string, string>();
  private readonly contexts = new Map<string, string>();
  getCursor(accountId: string): string { return this.cursors.get(accountId) ?? ""; }
  async setCursor(accountId: string, cursor: string): Promise<void> { this.cursors.set(accountId, cursor); }
  getContextToken(accountId: string, peerId: string): string { return this.contexts.get(`${accountId}\0${peerId}`) ?? ""; }
  async setContextToken(accountId: string, peerId: string, token: string): Promise<void> { this.contexts.set(`${accountId}\0${peerId}`, token); }
}

function rawMessage(
  messageId: string,
  seq: number,
  item: NonNullable<Parameters<typeof extractWeixinText>[0]["item_list"]>[number],
  contextToken?: string
) {
  return {
    from_user_id: "user-1",
    message_id: messageId,
    seq,
    ...(contextToken ? { context_token: contextToken } : {}),
    item_list: [item]
  };
}

function mediaFixture(name: string, plaintext: Buffer) {
  const key = Buffer.from(`${name}-key-0000000`.slice(0, 16));
  const cipher = createCipheriv("aes-128-ecb", key, null);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    plaintext,
    encrypted,
    media: {
      encrypt_query_param: name,
      aes_key: Buffer.from(key.toString("hex"), "utf8").toString("base64"),
      encrypt_type: 1
    }
  };
}

function localAttachment(
  root: string,
  kind: "image" | "audio" | "video" | "file",
  name: string,
  mimeType: string,
  data: Buffer
) {
  const localPath = path.join(root, name);
  fs.writeFileSync(localPath, data);
  return { id: `attachment-${kind}`, kind, localPath, mimeType, size: data.length, name };
}

async function eventually(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
