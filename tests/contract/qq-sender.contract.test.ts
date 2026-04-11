import { describe, expect, it, vi } from "vitest";
import { MediaArtifactKind } from "../../packages/domain/src/message.js";
import { QqSender, chunkTextForQq } from "../../packages/adapters/qq/src/qq-sender.js";

describe("qq sender", () => {
  it("splits long plain text into 5000-char chunks", () => {
    const text = "a".repeat(10020);
    const chunks = chunkTextForQq(text, 5000);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(5000);
    expect(chunks[1]).toHaveLength(5000);
    expect(chunks[2]).toHaveLength(20);
  });

  it("splits fenced markdown text without breaking code fences", () => {
    const markdown = [
      "```javascript",
      "const lines = [",
      ...Array.from({ length: 80 }, (_, index) => `  ${index + 1},`),
      "];",
      "```"
    ].join("\n");

    const chunks = chunkTextForQq(markdown, 160, "markdown");

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.startsWith("```javascript")).toBe(true);
      expect(chunk.trimEnd().endsWith("```")).toBe(true);
    }
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

    expect(apiClient.sendC2CMessage).toHaveBeenCalledWith(
      "OPENID123",
      "hello",
      "qq-inbound-1",
      { preferMarkdown: false }
    );
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

    expect(apiClient.sendC2CMessage).toHaveBeenCalledWith(
      "OPENID123",
      "图片如下：\n",
      "qq-inbound-2",
      { preferMarkdown: false }
    );
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
      "qq-inbound-3",
      { preferMarkdown: false }
    );
    expect(apiClient.sendC2CMessage).toHaveBeenNthCalledWith(
      2,
      "OPENID123",
      "a".repeat(5000),
      "qq-inbound-3",
      { preferMarkdown: false }
    );
    expect(apiClient.sendC2CMessage).toHaveBeenNthCalledWith(
      3,
      "OPENID123",
      "a".repeat(20),
      "qq-inbound-3",
      { preferMarkdown: false }
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
      "qq-inbound-4",
      { preferMarkdown: false }
    );
    expect(apiClient.sendC2CMediaArtifact).toHaveBeenCalledTimes(1);
    expect(apiClient.sendC2CMessage).toHaveBeenNthCalledWith(
      2,
      "OPENID123",
      expect.stringContaining("媒体发送失败"),
      "qq-inbound-4",
      { preferMarkdown: false }
    );
    expect(apiClient.sendC2CMessage).toHaveBeenNthCalledWith(
      3,
      "OPENID123",
      "\n结尾文本",
      "qq-inbound-4",
      { preferMarkdown: false }
    );
  });

  it("preserves markdown links and normalizes remote markdown images for qq markdown mode", async () => {
    const apiClient = {
      sendC2CMessage: vi.fn().mockResolvedValue("qq-msg-markdown"),
      sendGroupMessage: vi.fn(),
      sendC2CMediaArtifact: vi.fn(),
      sendGroupMediaArtifact: vi.fn()
    };
    const sender = new QqSender(apiClient);

    await sender.deliver({
      draftId: "draft-5",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      text: [
        "测试图片",
        "![封面](https://example.com/cover.png)",
        "[点击打开测试音频 MP3](https://example.com/demo.mp3)"
      ].join("\n"),
      createdAt: "2026-04-09T10:00:05.000Z",
      replyToMessageId: "qq-inbound-5"
    });

    expect(apiClient.sendC2CMediaArtifact).not.toHaveBeenCalled();
    expect(apiClient.sendC2CMessage).toHaveBeenCalledWith(
      "OPENID123",
      [
        "测试图片",
        "![#512px #512px](https://example.com/cover.png)",
        "[点击打开测试音频 MP3](https://example.com/demo.mp3)"
      ].join("\n"),
      "qq-inbound-5",
      { preferMarkdown: true }
    );
  });

  it("sends fenced code blocks in qq markdown mode", async () => {
    const apiClient = {
      sendC2CMessage: vi.fn().mockResolvedValue("qq-msg-code"),
      sendGroupMessage: vi.fn(),
      sendC2CMediaArtifact: vi.fn(),
      sendGroupMediaArtifact: vi.fn()
    };
    const sender = new QqSender(apiClient);

    const codeReply = [
      "下面是一段示例代码：",
      "```javascript",
      "function add(a, b) {",
      "  return a + b;",
      "}",
      "```"
    ].join("\n");

    await sender.deliver({
      draftId: "draft-7",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      text: codeReply,
      createdAt: "2026-04-10T16:50:00.000Z",
      replyToMessageId: "qq-inbound-7"
    });

    expect(apiClient.sendC2CMessage).toHaveBeenCalledWith(
      "OPENID123",
      codeReply,
      "qq-inbound-7",
      { preferMarkdown: true }
    );
  });

  it("sends markdown tables in qq markdown mode", async () => {
    const apiClient = {
      sendC2CMessage: vi.fn().mockResolvedValue("qq-msg-table"),
      sendGroupMessage: vi.fn(),
      sendC2CMediaArtifact: vi.fn(),
      sendGroupMediaArtifact: vi.fn()
    };
    const sender = new QqSender(apiClient);

    const tableReply = [
      "| 类型 | 内容 |",
      "| --- | --- |",
      "| 基础版 | 最容易理解的闭包示例 |",
      "| 实战版 | 用闭包实现缓存 |"
    ].join("\n");

    await sender.deliver({
      draftId: "draft-7b",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      text: tableReply,
      createdAt: "2026-04-10T17:10:00.000Z",
      replyToMessageId: "qq-inbound-7b"
    });

    expect(apiClient.sendC2CMessage).toHaveBeenCalledWith(
      "OPENID123",
      tableReply,
      "qq-inbound-7b",
      { preferMarkdown: true }
    );
  });

  it("does not send duplicate media when the draft already contains the parsed artifact", async () => {
    const apiClient = {
      sendC2CMessage: vi.fn().mockResolvedValue("qq-msg-dedupe"),
      sendGroupMessage: vi.fn(),
      sendC2CMediaArtifact: vi.fn().mockResolvedValue("qq-msg-media"),
      sendGroupMediaArtifact: vi.fn()
    };
    const sender = new QqSender(apiClient);

    await sender.deliver({
      draftId: "draft-6",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      text: "图片如下：\n<qqmedia>/tmp/cat.png</qqmedia>",
      mediaArtifacts: [
        {
          kind: MediaArtifactKind.Image,
          sourceUrl: "/tmp/cat.png",
          localPath: "/tmp/cat.png",
          mimeType: "image/png",
          fileSize: 0,
          originalName: "cat.png"
        }
      ],
      createdAt: "2026-04-09T10:00:06.000Z",
      replyToMessageId: "qq-inbound-6"
    });

    expect(apiClient.sendC2CMediaArtifact).toHaveBeenCalledTimes(1);
  });
});
