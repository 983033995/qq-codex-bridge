import { describe, expect, it } from "vitest";
import { MediaArtifactKind, type InboundMessage } from "../../packages/domain/src/message.js";
import { buildCodexInboundText } from "../../packages/orchestrator/src/media-context.js";

describe("media context", () => {
  it("injects attachment metadata as hidden context instead of visible blocks", () => {
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
    expect(text).toContain("<!-- QQBOT_ATTACHMENTS");
    expect(text).toContain("path=/tmp/qq-media/report.txt");
    expect(text).toContain("extracted=这是报告正文");
    expect(text).not.toContain("[QQ附件]");
    expect(text).not.toContain("[report.txt](/tmp/qq-media/report.txt)");
  });

  it("injects qqbot media skill guidance as hidden runtime context", () => {
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

    expect(text).toContain("<!-- QQBOT_RUNTIME_CONTEXT");
    expect(text).toContain("<qqmedia>绝对路径或URL</qqmedia>");
    expect(text).toContain("不要解释 bridge、runtime/media、相对路径");
    expect(text).toContain("图片 30MB");
    expect(text).not.toContain("[QQBot运行说明]");
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

  it("supports turning off qqbot skill guidance after the thread is seeded", () => {
    const text = buildCodexInboundText(
      {
        messageId: "msg-seeded",
        accountKey: "qqbot:default",
        sessionKey: "qqbot:default::qq:c2c:abc",
        peerKey: "qq:c2c:abc",
        chatType: "c2c",
        senderId: "abc",
        text: "第二轮普通提问",
        receivedAt: "2026-04-09T18:02:00.000Z"
      },
      { includeSkillContext: false }
    );

    expect(text).toBe("第二轮普通提问");
  });

  it("uses a compact placeholder when a qq message only contains attachments", () => {
    const text = buildCodexInboundText({
      messageId: "msg-attachment-only",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:abc",
      peerKey: "qq:c2c:abc",
      chatType: "c2c",
      senderId: "abc",
      text: "",
      mediaArtifacts: [
        {
          kind: MediaArtifactKind.Image,
          sourceUrl: "https://example.com/image.png",
          localPath: "/tmp/qq-media/image.png",
          mimeType: "image/png",
          fileSize: 256,
          originalName: "image.png"
        }
      ],
      receivedAt: "2026-04-09T18:03:00.000Z"
    });

    expect(text).toContain("（用户发送了 1 个 QQ 附件）");
    expect(text).toContain("<!-- QQBOT_ATTACHMENTS");
  });

  it("renders voice transcripts as visible text for codex without adding attachment metadata comments", () => {
    const text = buildCodexInboundText({
      messageId: "msg-voice",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:voice",
      peerKey: "qq:c2c:voice",
      chatType: "c2c",
      senderId: "voice-user",
      text: "",
      mediaArtifacts: [
        {
          kind: MediaArtifactKind.Audio,
          sourceUrl: "https://example.com/voice.wav",
          localPath: "/tmp/qq-media/voice.wav",
          mimeType: "audio/wav",
          fileSize: 512,
          originalName: "voice.amr",
          transcript: "这是一段已经转写的语音内容。",
          transcriptSource: "stt",
          extractedText: "这是一段已经转写的语音内容。"
        }
      ],
      receivedAt: "2026-04-09T18:04:00.000Z"
    });

    expect(text).toContain("[语音消息] 这是一段已经转写的语音内容。");
    expect(text).not.toContain("（用户发送了 1 个 QQ 附件）");
    expect(text).not.toContain("<!-- QQBOT_ATTACHMENTS");
    expect(text).not.toContain("transcript=这是一段已经转写的语音内容。");
    expect(text).not.toContain("transcriptSource=stt");
  });
});
