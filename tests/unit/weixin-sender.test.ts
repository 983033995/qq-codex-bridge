import { describe, expect, it, vi } from "vitest";
import { MediaArtifactKind, type OutboundDraft } from "../../packages/domain/src/message.js";
import { WeixinSender } from "../../packages/adapters/weixin/src/weixin-sender.js";

function createDraft(overrides: Partial<OutboundDraft> = {}): OutboundDraft {
  return {
    draftId: "draft-weixin-1",
    sessionKey: "weixin:default::wx:c2c:wxid_peer",
    text: "",
    createdAt: "2026-04-15T12:00:00.000Z",
    ...overrides
  };
}

describe("weixin sender", () => {
  it("routes qqmedia references as media artifacts instead of empty text payloads", async () => {
    const apiClient = {
      sendMessage: vi.fn().mockResolvedValue("provider-msg-1")
    };
    const sender = new WeixinSender(apiClient as never);

    await sender.deliver(
      createDraft({
        text: "<qqmedia>/tmp/demo.jpg</qqmedia>"
      })
    );

    expect(apiClient.sendMessage).toHaveBeenCalledWith({
      peerId: "wxid_peer",
      chatType: "c2c",
      content: undefined,
      mediaArtifacts: [
        expect.objectContaining({
          kind: MediaArtifactKind.Image,
          localPath: "/tmp/demo.jpg",
          originalName: "demo.jpg"
        })
      ],
      replyToMessageId: undefined
    });
  });

  it("merges explicit media artifacts with plain text into one outbound payload", async () => {
    const apiClient = {
      sendMessage: vi.fn().mockResolvedValue("provider-msg-2")
    };
    const sender = new WeixinSender(apiClient as never);

    await sender.deliver(
      createDraft({
        text: "这是补充说明",
        mediaArtifacts: [
          {
            kind: MediaArtifactKind.Video,
            sourceUrl: "/tmp/demo.mp4",
            localPath: "/tmp/demo.mp4",
            mimeType: "video/mp4",
            fileSize: 4096,
            originalName: "demo.mp4"
          }
        ]
      })
    );

    expect(apiClient.sendMessage).toHaveBeenNthCalledWith(1, {
      peerId: "wxid_peer",
      chatType: "c2c",
      content: "这是补充说明",
      replyToMessageId: undefined
    });
    expect(apiClient.sendMessage).toHaveBeenNthCalledWith(2, {
      peerId: "wxid_peer",
      chatType: "c2c",
      mediaArtifacts: [
        expect.objectContaining({
          kind: MediaArtifactKind.Video,
          localPath: "/tmp/demo.mp4"
        })
      ],
      replyToMessageId: undefined
    });
  });

  it("splits long weixin text into smaller outbound text messages", async () => {
    const apiClient = {
      sendMessage: vi.fn()
        .mockResolvedValueOnce("provider-msg-1")
        .mockResolvedValueOnce("provider-msg-2")
        .mockResolvedValueOnce("provider-msg-3")
    };
    const sender = new WeixinSender(apiClient as never);
    const firstBlock = "第一段".repeat(500);
    const secondBlock = "第二段".repeat(500);
    const thirdBlock = "第三段".repeat(200);

    await sender.deliver(
      createDraft({
        text: `${firstBlock}\n\n${secondBlock}\n\n${thirdBlock}`,
        replyToMessageId: "wx-msg-long"
      })
    );

    expect(apiClient.sendMessage).toHaveBeenCalledTimes(3);
    for (const call of apiClient.sendMessage.mock.calls) {
      expect(call[0].content.length).toBeLessThanOrEqual(1800);
      expect(call[0]).toMatchObject({
        peerId: "wxid_peer",
        chatType: "c2c",
        replyToMessageId: "wx-msg-long"
      });
    }
    expect(apiClient.sendMessage.mock.calls.map((call) => call[0].content).join("\n\n"))
      .toContain(firstBlock);
    expect(apiClient.sendMessage.mock.calls.map((call) => call[0].content).join("\n\n"))
      .toContain(secondBlock);
  });

  it("splits mixed text and multiple media artifacts into separate outbound requests", async () => {
    const apiClient = {
      sendMessage: vi.fn().mockResolvedValue("provider-msg-3")
    };
    const sender = new WeixinSender(apiClient as never);

    await sender.deliver(
      createDraft({
        text: "新歌已生成",
        mediaArtifacts: [
          {
            kind: MediaArtifactKind.Audio,
            sourceUrl: "/tmp/song.mp3",
            localPath: "/tmp/song.mp3",
            mimeType: "audio/mpeg",
            fileSize: 1234,
            originalName: "song.mp3"
          },
          {
            kind: MediaArtifactKind.Image,
            sourceUrl: "/tmp/cover.jpg",
            localPath: "/tmp/cover.jpg",
            mimeType: "image/jpeg",
            fileSize: 5678,
            originalName: "cover.jpg"
          },
          {
            kind: MediaArtifactKind.File,
            sourceUrl: "/tmp/metadata.json",
            localPath: "/tmp/metadata.json",
            mimeType: "application/json",
            fileSize: 345,
            originalName: "metadata.json"
          }
        ],
        replyToMessageId: "wx-msg-1"
      })
    );

    expect(apiClient.sendMessage).toHaveBeenCalledTimes(4);
    expect(apiClient.sendMessage).toHaveBeenNthCalledWith(1, {
      peerId: "wxid_peer",
      chatType: "c2c",
      content: "新歌已生成",
      replyToMessageId: "wx-msg-1"
    });
    expect(apiClient.sendMessage).toHaveBeenNthCalledWith(2, {
      peerId: "wxid_peer",
      chatType: "c2c",
      mediaArtifacts: [
        expect.objectContaining({
          kind: MediaArtifactKind.Audio,
          localPath: "/tmp/song.mp3"
        })
      ],
      replyToMessageId: "wx-msg-1"
    });
    expect(apiClient.sendMessage).toHaveBeenNthCalledWith(3, {
      peerId: "wxid_peer",
      chatType: "c2c",
      mediaArtifacts: [
        expect.objectContaining({
          kind: MediaArtifactKind.Image,
          localPath: "/tmp/cover.jpg"
        })
      ],
      replyToMessageId: "wx-msg-1"
    });
    expect(apiClient.sendMessage).toHaveBeenNthCalledWith(4, {
      peerId: "wxid_peer",
      chatType: "c2c",
      mediaArtifacts: [
        expect.objectContaining({
          kind: MediaArtifactKind.File,
          localPath: "/tmp/metadata.json"
        })
      ],
      replyToMessageId: "wx-msg-1"
    });
  });
});
