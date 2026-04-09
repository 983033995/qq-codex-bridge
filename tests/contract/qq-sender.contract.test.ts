import { describe, expect, it, vi } from "vitest";
import { MediaArtifactKind } from "../../packages/domain/src/message.js";
import { QqSender, chunkTextForQq } from "../../packages/adapters/qq/src/qq-sender.js";

describe("qq sender", () => {
  it("splits long text into 5000-char chunks", () => {
    const text = "a".repeat(10020);
    const chunks = chunkTextForQq(text, 5000);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(5000);
    expect(chunks[1]).toHaveLength(5000);
    expect(chunks[2]).toHaveLength(20);
  });

  it("routes c2c drafts through the qq api client", async () => {
    const apiClient = {
      sendC2CMessage: vi.fn().mockResolvedValue("qq-msg-1"),
      sendGroupMessage: vi.fn(),
      sendC2CMediaArtifact: vi.fn(),
      sendGroupMediaArtifact: vi.fn()
    };
    const sender = new QqSender(apiClient);

    await expect(
      sender.deliver({
        draftId: "draft-1",
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        text: "hello",
        createdAt: "2026-04-09T10:00:00.000Z",
        replyToMessageId: "qq-inbound-1"
      })
    ).resolves.toEqual({
      jobId: "draft-1",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      providerMessageId: "qq-msg-1",
      deliveredAt: "2026-04-09T10:00:00.000Z"
    });

    expect(apiClient.sendC2CMessage).toHaveBeenCalledWith("OPENID123", "hello", "qq-inbound-1");
    expect(apiClient.sendGroupMessage).not.toHaveBeenCalled();
  });

  it("routes qqmedia declarations through the qq media api client", async () => {
    const apiClient = {
      sendC2CMessage: vi.fn().mockResolvedValue("qq-msg-text"),
      sendGroupMessage: vi.fn(),
      sendC2CMediaArtifact: vi.fn().mockResolvedValue("qq-msg-media"),
      sendGroupMediaArtifact: vi.fn()
    };
    const sender = new QqSender(apiClient);

    await expect(
      sender.deliver({
        draftId: "draft-2",
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        text: "图片如下：\n<qqmedia>/tmp/cat.png</qqmedia>",
        createdAt: "2026-04-09T10:00:02.000Z",
        replyToMessageId: "qq-inbound-2"
      })
    ).resolves.toEqual({
      jobId: "draft-2",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      providerMessageId: "qq-msg-media",
      deliveredAt: "2026-04-09T10:00:02.000Z"
    });

    expect(apiClient.sendC2CMessage).toHaveBeenCalledWith("OPENID123", "图片如下：\n", "qq-inbound-2");
    expect(apiClient.sendC2CMediaArtifact).toHaveBeenCalledWith(
      "OPENID123",
      expect.objectContaining({
        kind: MediaArtifactKind.Image,
        localPath: "/tmp/cat.png",
        sourceUrl: "/tmp/cat.png"
      }),
      "qq-inbound-2"
    );
  });

  it("chunks long text replies instead of sending them as one oversized qq message", async () => {
    const apiClient = {
      sendC2CMessage: vi.fn().mockResolvedValue("qq-msg-text"),
      sendGroupMessage: vi.fn(),
      sendC2CMediaArtifact: vi.fn(),
      sendGroupMediaArtifact: vi.fn()
    };
    const sender = new QqSender(apiClient);

    await sender.deliver({
      draftId: "draft-3",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      text: "a".repeat(10020),
      createdAt: "2026-04-09T10:00:03.000Z",
      replyToMessageId: "qq-inbound-3"
    });

    expect(apiClient.sendC2CMessage).toHaveBeenCalledTimes(3);
    expect(apiClient.sendC2CMessage).toHaveBeenNthCalledWith(
      1,
      "OPENID123",
      "a".repeat(5000),
      "qq-inbound-3"
    );
    expect(apiClient.sendC2CMessage).toHaveBeenNthCalledWith(
      2,
      "OPENID123",
      "a".repeat(5000),
      "qq-inbound-3"
    );
    expect(apiClient.sendC2CMessage).toHaveBeenNthCalledWith(
      3,
      "OPENID123",
      "a".repeat(20),
      "qq-inbound-3"
    );
  });

  it("continues sending trailing text when a media artifact fails to send", async () => {
    const apiClient = {
      sendC2CMessage: vi.fn().mockResolvedValue("qq-msg-text"),
      sendGroupMessage: vi.fn(),
      sendC2CMediaArtifact: vi.fn().mockRejectedValue(new Error("QQ media upload failed: 400")),
      sendGroupMediaArtifact: vi.fn()
    };
    const sender = new QqSender(apiClient);

    await expect(
      sender.deliver({
        draftId: "draft-4",
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        text: [
          "开头文本",
          "<qqmedia>/tmp/cat.png</qqmedia>",
          "结尾文本"
        ].join("\n"),
        createdAt: "2026-04-09T10:00:04.000Z",
        replyToMessageId: "qq-inbound-4"
      })
    ).resolves.toEqual({
      jobId: "draft-4",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      providerMessageId: "qq-msg-text",
      deliveredAt: "2026-04-09T10:00:04.000Z"
    });

    expect(apiClient.sendC2CMessage).toHaveBeenNthCalledWith(
      1,
      "OPENID123",
      "开头文本\n",
      "qq-inbound-4"
    );
    expect(apiClient.sendC2CMediaArtifact).toHaveBeenCalledTimes(1);
    expect(apiClient.sendC2CMessage).toHaveBeenNthCalledWith(
      2,
      "OPENID123",
      expect.stringContaining("媒体发送失败"),
      "qq-inbound-4"
    );
    expect(apiClient.sendC2CMessage).toHaveBeenNthCalledWith(
      3,
      "OPENID123",
      "\n结尾文本",
      "qq-inbound-4"
    );
  });
});
