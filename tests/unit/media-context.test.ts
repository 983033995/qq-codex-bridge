import { describe, expect, it } from "vitest";
import { MediaArtifactKind, type InboundMessage } from "../../packages/domain/src/message.js";
import { buildCodexInboundText } from "../../packages/orchestrator/src/media-context.js";

describe("media context", () => {
  it("injects attachment paths and extracted text into the codex user message", () => {
    const message: InboundMessage = {
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:abc",
      peerKey: "qq:c2c:abc",
      chatType: "c2c",
      senderId: "abc",
      text: "帮我看看附件",
      mediaArtifacts: [
        {
          kind: MediaArtifactKind.File,
          sourceUrl: "https://example.com/report.txt",
          localPath: "/tmp/qq-media/report.txt",
          mimeType: "text/plain",
          fileSize: 128,
          originalName: "report.txt",
          extractedText: "这是报告正文"
        }
      ],
      receivedAt: "2026-04-09T11:00:00.000Z"
    };

    const text = buildCodexInboundText(message);

    expect(text).toContain("帮我看看附件");
    expect(text).toContain("/tmp/qq-media/report.txt");
    expect(text).toContain("这是报告正文");
    expect(text).toContain("附件 1");
  });

  it("injects qqbot media skill guidance for qqbot inbound messages", () => {
    const text = buildCodexInboundText({
      messageId: "msg-qqbot-skill",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:abc",
      peerKey: "qq:c2c:abc",
      chatType: "c2c",
      senderId: "abc",
      text: "请把图片和音频发给我",
      receivedAt: "2026-04-09T18:00:00.000Z"
    });

    expect(text).toContain("【QQBot桥接技能】");
    expect(text).toContain("<qqmedia>绝对路径或URL</qqmedia>");
    expect(text).toContain("不要只说“已发送图片”");
    expect(text).toContain("图片最大 30MB");
  });

  it("does not inject qqbot guidance for non-qqbot accounts", () => {
    const text = buildCodexInboundText({
      messageId: "msg-non-qqbot",
      accountKey: "feishu:default",
      sessionKey: "feishu:default::feishu:c2c:abc",
      peerKey: "feishu:c2c:abc",
      chatType: "c2c",
      senderId: "abc",
      text: "普通消息",
      receivedAt: "2026-04-09T18:01:00.000Z"
    });

    expect(text).toBe("普通消息");
  });
});
