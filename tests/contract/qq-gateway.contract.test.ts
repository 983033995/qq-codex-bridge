import { describe, expect, it, vi } from "vitest";
import { MediaArtifactKind } from "../../packages/domain/src/message.js";
import { QqGateway } from "../../packages/adapters/qq/src/qq-gateway.js";

describe("qq gateway", () => {
  it("normalizes a c2c payload before dispatching it to the message handler", async () => {
    const gateway = new QqGateway({ accountKey: "qqbot:default" });
    const handler = vi.fn().mockResolvedValue(undefined);

    await gateway.onMessage(handler);
    await gateway.dispatchPayload({
      t: "C2C_MESSAGE_CREATE",
      d: {
        id: "msg-1",
        content: "hello",
        timestamp: "2026-04-09T10:00:00.000Z",
        author: {
          user_openid: "OPENID123"
        }
      }
    });

    expect(handler).toHaveBeenCalledWith({
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      senderId: "OPENID123",
      text: "hello",
      receivedAt: "2026-04-09T10:00:00.000Z"
    });
  });

  it("normalizes a group payload before dispatching it to the message handler", async () => {
    const gateway = new QqGateway({ accountKey: "qqbot:default" });
    const handler = vi.fn().mockResolvedValue(undefined);

    await gateway.onMessage(handler);
    await gateway.dispatchPayload({
      t: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "msg-2",
        content: "@bot hi",
        timestamp: "2026-04-09T10:00:01.000Z",
        group_openid: "GROUP001",
        author: {
          member_openid: "MEMBER001"
        }
      }
    });

    expect(handler).toHaveBeenCalledWith({
      messageId: "msg-2",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:group:GROUP001",
      peerKey: "qq:group:GROUP001",
      chatType: "group",
      senderId: "MEMBER001",
      text: "@bot hi",
      receivedAt: "2026-04-09T10:00:01.000Z"
    });
  });

  it("ignores unsupported event types without dispatching a message", async () => {
    const gateway = new QqGateway({ accountKey: "qqbot:default" });
    const handler = vi.fn().mockResolvedValue(undefined);

    await gateway.onMessage(handler);
    await gateway.dispatchPayload({
      t: "GUILD_MESSAGE_CREATE",
      d: {
        id: "msg-3",
        content: "ignored",
        timestamp: "2026-04-09T10:00:02.000Z"
      }
    } as never);

    expect(handler).not.toHaveBeenCalled();
  });

  it("downloads attachments and forwards them as media artifacts", async () => {
    const downloadMediaArtifact = vi.fn().mockResolvedValue({
      kind: MediaArtifactKind.Image,
      sourceUrl: "https://example.com/cat.png",
      localPath: "/tmp/qq-media/cat.png",
      mimeType: "image/png",
      fileSize: 2048,
      originalName: "cat.png"
    });
    const gateway = new QqGateway({
      accountKey: "qqbot:default",
      mediaDownloader: {
        downloadMediaArtifact
      }
    });
    const handler = vi.fn().mockResolvedValue(undefined);

    await gateway.onMessage(handler);
    await gateway.dispatchPayload({
      t: "C2C_MESSAGE_CREATE",
      d: {
        id: "msg-4",
        content: "看图",
        timestamp: "2026-04-09T10:00:03.000Z",
        author: {
          user_openid: "OPENID999"
        },
        attachments: [
          {
            content_type: "image/png",
            filename: "cat.png",
            size: 2048,
            url: "https://example.com/cat.png"
          }
        ]
      }
    });

    expect(handler).toHaveBeenCalledWith({
      messageId: "msg-4",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:OPENID999",
      peerKey: "qq:c2c:OPENID999",
      chatType: "c2c",
      senderId: "OPENID999",
      text: "看图",
      mediaArtifacts: [
        {
          kind: MediaArtifactKind.Image,
          sourceUrl: "https://example.com/cat.png",
          localPath: "/tmp/qq-media/cat.png",
          mimeType: "image/png",
          fileSize: 2048,
          originalName: "cat.png"
        }
      ],
      receivedAt: "2026-04-09T10:00:03.000Z"
    });
    expect(downloadMediaArtifact).toHaveBeenCalledWith({
      sourceUrl: "https://example.com/cat.png",
      originalName: "cat.png",
      mimeType: "image/png",
      fileSize: 2048,
      voiceWavUrl: null,
      asrReferText: null
    });
  });

  it("passes voice_wav_url and asr_refer_text to the media downloader for voice attachments", async () => {
    const downloadMediaArtifact = vi.fn().mockResolvedValue({
      kind: MediaArtifactKind.Audio,
      sourceUrl: "https://example.com/voice.wav",
      localPath: "/tmp/qq-media/voice.wav",
      mimeType: "audio/wav",
      fileSize: 4096,
      originalName: "voice.amr",
      transcript: "你好，这是一段语音。",
      transcriptSource: "asr",
      extractedText: "你好，这是一段语音。"
    });
    const gateway = new QqGateway({
      accountKey: "qqbot:default",
      mediaDownloader: {
        downloadMediaArtifact
      }
    });
    const handler = vi.fn().mockResolvedValue(undefined);

    await gateway.onMessage(handler);
    await gateway.dispatchPayload({
      t: "C2C_MESSAGE_CREATE",
      d: {
        id: "msg-voice-1",
        content: "",
        timestamp: "2026-04-09T10:00:03.000Z",
        author: {
          user_openid: "OPENIDVOICE"
        },
        attachments: [
          {
            content_type: "voice",
            filename: "voice.amr",
            size: 4096,
            url: "https://example.com/voice.amr",
            voice_wav_url: "https://example.com/voice.wav",
            asr_refer_text: "你好，这是一段语音。"
          }
        ]
      }
    });

    expect(downloadMediaArtifact).toHaveBeenCalledWith({
      sourceUrl: "https://example.com/voice.amr",
      originalName: "voice.amr",
      mimeType: "voice",
      fileSize: 4096,
      voiceWavUrl: "https://example.com/voice.wav",
      asrReferText: "你好，这是一段语音。"
    });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaArtifacts: [
          expect.objectContaining({
            kind: MediaArtifactKind.Audio,
            transcript: "你好，这是一段语音。",
            transcriptSource: "asr"
          })
        ]
      })
    );
  });

  it("keeps dispatching the text payload when attachment download fails", async () => {
    const gateway = new QqGateway({
      accountKey: "qqbot:default",
      mediaDownloader: {
        downloadMediaArtifact: vi.fn().mockRejectedValue(new Error("download failed"))
      }
    });
    const handler = vi.fn().mockResolvedValue(undefined);

    await gateway.onMessage(handler);
    await gateway.dispatchPayload({
      t: "C2C_MESSAGE_CREATE",
      d: {
        id: "msg-5",
        content: "图片和文字一起发",
        timestamp: "2026-04-09T10:00:04.000Z",
        author: {
          user_openid: "OPENID777"
        },
        attachments: [
          {
            content_type: "image/png",
            filename: "cat.png",
            size: 2048,
            url: "//gchat.qpic.cn/qqbot/cat.png"
          }
        ]
      }
    });

    expect(handler).toHaveBeenCalledWith({
      messageId: "msg-5",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:OPENID777",
      peerKey: "qq:c2c:OPENID777",
      chatType: "c2c",
      senderId: "OPENID777",
      text: "图片和文字一起发",
      receivedAt: "2026-04-09T10:00:04.000Z"
    });
  });
});
