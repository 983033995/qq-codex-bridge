import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaArtifactKind } from "../../packages/domain/src/message.js";
import { extractWeixinText, WeixinClient } from "../../apps/weixin-gateway/src/weixin-client.js";
import { WeixinGatewayStateStore } from "../../apps/weixin-gateway/src/state.js";

describe("weixin client media sending", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uploads image artifacts before sending media messages", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-client-media-"));
    const imagePath = path.join(tempDir, "demo.jpg");
    const statePath = path.join(tempDir, "state.json");
    fs.writeFileSync(imagePath, Buffer.from("fake-image-payload"), "utf8");

    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            ret: 0,
            upload_param: "encrypted-upload-query"
          }),
        json: async () => ({
          ret: 0,
          upload_param: "encrypted-upload-query"
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({
          "x-encrypted-param": "cdn-param"
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ ret: 0 }),
        json: async () => ({ ret: 0 })
      });

    const client = new WeixinClient({
      accountId: "default",
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "bot-token",
      longPollTimeoutMs: 35_000,
      apiTimeoutMs: 15_000,
      stateStore: new WeixinGatewayStateStore(statePath),
      fetchFn: fetchFn as never,
      onInboundMessage: vi.fn()
    });

    await client.sendMessage({
      peerId: "wxid_peer",
      chatType: "c2c",
      mediaArtifacts: [
        {
          kind: MediaArtifactKind.Image,
          sourceUrl: imagePath,
          localPath: imagePath,
          mimeType: "image/jpeg",
          fileSize: fs.statSync(imagePath).size,
          originalName: "demo.jpg"
        }
      ],
      contextToken: "context-token"
    });

    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      "https://ilinkai.weixin.qq.com/ilink/bot/getuploadurl",
      expect.objectContaining({
        method: "POST"
      })
    );
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("https://novac2c.cdn.weixin.qq.com/c2c/upload"),
      expect.objectContaining({
        method: "POST"
      })
    );
    expect(fetchFn).toHaveBeenNthCalledWith(
      3,
      "https://ilinkai.weixin.qq.com/ilink/bot/sendmessage",
      expect.objectContaining({
        method: "POST"
      })
    );
  });

  it("sends audio artifacts as playable file attachments", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-client-voice-"));
    const audioPath = path.join(tempDir, "brief.mp3");
    const statePath = path.join(tempDir, "state.json");
    fs.writeFileSync(audioPath, Buffer.from("fake-mp3-payload"));
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ ret: 0, upload_param: "voice-upload" })
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "x-encrypted-param": "voice-cdn-param" })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ ret: 0 })
      });
    const client = new WeixinClient({
      accountId: "default",
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "bot-token",
      longPollTimeoutMs: 35_000,
      apiTimeoutMs: 15_000,
      stateStore: new WeixinGatewayStateStore(statePath),
      fetchFn: fetchFn as never,
      onInboundMessage: vi.fn()
    });

    await client.sendMessage({
      peerId: "wxid_peer",
      chatType: "c2c",
      mediaArtifacts: [{
        kind: MediaArtifactKind.Audio,
        sourceUrl: "",
        localPath: audioPath,
        mimeType: "audio/mpeg",
        fileSize: fs.statSync(audioPath).size,
        originalName: "brief.mp3"
      }]
    });

    const uploadBody = JSON.parse(String((fetchFn.mock.calls[0]?.[1] as RequestInit).body));
    expect(uploadBody.media_type).toBe(3);
    const sendBody = JSON.parse(String((fetchFn.mock.calls[2]?.[1] as RequestInit).body));
    const encodedAesKey = sendBody.msg.item_list[0].file_item.media.aes_key as string;
    expect(Buffer.from(encodedAesKey, "base64").toString("utf8")).toMatch(/^[0-9a-f]{32}$/);
    expect(sendBody.msg.item_list[0]).toMatchObject({
      type: 4,
      file_item: {
        media: { encrypt_query_param: "voice-cdn-param" },
        file_name: "brief.mp3",
        len: String(fs.statSync(audioPath).size)
      }
    });
  });

  it("pairs thumbnail images with the following video into a single video item", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-client-video-"));
    const thumbPath = path.join(tempDir, "video-thumbnail.jpg");
    const videoPath = path.join(tempDir, "preview.mp4");
    const statePath = path.join(tempDir, "state.json");
    fs.writeFileSync(thumbPath, Buffer.from("fake-thumb"), "utf8");
    fs.writeFileSync(videoPath, Buffer.from("fake-video-payload"), "utf8");

    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ ret: 0, upload_param: "thumb-upload" })
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({
          "x-encrypted-param": "thumb-cdn-param"
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ ret: 0, upload_param: "video-upload" })
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({
          "x-encrypted-param": "video-cdn-param"
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ ret: 0 })
      });

    const client = new WeixinClient({
      accountId: "default",
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "bot-token",
      longPollTimeoutMs: 35_000,
      apiTimeoutMs: 15_000,
      stateStore: new WeixinGatewayStateStore(statePath),
      fetchFn: fetchFn as never,
      onInboundMessage: vi.fn()
    });

    await client.sendMessage({
      peerId: "wxid_peer",
      chatType: "c2c",
      mediaArtifacts: [
        {
          kind: MediaArtifactKind.Image,
          sourceUrl: thumbPath,
          localPath: thumbPath,
          mimeType: "image/jpeg",
          fileSize: fs.statSync(thumbPath).size,
          originalName: "video-thumbnail.jpg"
        },
        {
          kind: MediaArtifactKind.Video,
          sourceUrl: videoPath,
          localPath: videoPath,
          mimeType: "video/mp4",
          fileSize: fs.statSync(videoPath).size,
          originalName: "preview.mp4"
        }
      ],
      contextToken: "context-token"
    });

    const sendPayloadCall = fetchFn.mock.calls[4];
    expect(sendPayloadCall?.[0]).toBe("https://ilinkai.weixin.qq.com/ilink/bot/sendmessage");
    const requestInit = sendPayloadCall?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body));
    expect(body.msg.item_list).toHaveLength(1);
    expect(body.msg.item_list[0]).toMatchObject({
      type: 5,
      video_item: {
        media: {
          encrypt_query_param: "video-cdn-param"
        },
        thumb_media: {
          encrypt_query_param: "thumb-cdn-param"
        }
      }
    });
  });
});

describe("weixin inbound text extraction", () => {
  it("still reads plain text and transcribed voice messages", () => {
    expect(extractWeixinText({ item_list: [{ type: 1, text_item: { text: "你好" } }] })).toBe("你好");
    expect(
      extractWeixinText({ item_list: [{ type: 3, voice_item: { text: "语音转写内容" } }] })
    ).toBe("语音转写内容");
  });

  it("surfaces a clear placeholder for image/file/video items instead of silently dropping them", () => {
    expect(extractWeixinText({ item_list: [{ type: 2 }] })).toContain("图片");
    expect(extractWeixinText({ item_list: [{ type: 2 }] })).toContain("暂不支持下载入站图片");
    expect(extractWeixinText({ item_list: [{ type: 4 }] })).toContain("暂不支持下载入站文件");
    expect(extractWeixinText({ item_list: [{ type: 5 }] })).toContain("暂不支持下载入站视频");
  });

  it("returns empty text when there is no recognizable item", () => {
    expect(extractWeixinText({})).toBe("");
    expect(extractWeixinText({ item_list: [] })).toBe("");
    expect(extractWeixinText({ item_list: [{ type: 99 }] })).toBe("");
  });
});
