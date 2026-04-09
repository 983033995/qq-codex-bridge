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
});
