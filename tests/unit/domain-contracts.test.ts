import { describe, expect, expectTypeOf, it } from "vitest";
import { BridgeSessionStatus } from "../../packages/domain/src/session.js";
import {
  MediaArtifactKind,
  type ConversationEntry,
  type InboundMessage,
  type OutboundDraft
} from "../../packages/domain/src/message.js";
import type { QqMediaDownloadPort, QqMediaSendPort } from "../../packages/ports/src/qq.js";

describe("domain contracts", () => {
  it("exposes bridge session statuses and inbound chat types", () => {
    const sample: InboundMessage = {
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:abc",
      peerKey: "qq:c2c:abc",
      chatType: "c2c",
      senderId: "abc",
      text: "hello",
      receivedAt: "2026-04-08T10:00:00.000Z"
    };

    expect(BridgeSessionStatus.Active).toBe("active");
    expect(sample.chatType).toBe("c2c");
  });

  it("models media artifacts on inbound, outbound, and transcript entries", () => {
    const mediaArtifact = {
      kind: MediaArtifactKind.Image,
      sourceUrl: "https://example.com/cat.png",
      localPath: "/tmp/qq-media/cat.png",
      mimeType: "image/png",
      fileSize: 2048,
      originalName: "cat.png",
      extractedText: "一只猫"
    };

    const inbound: InboundMessage = {
      messageId: "msg-2",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:abc",
      peerKey: "qq:c2c:abc",
      chatType: "c2c",
      senderId: "abc",
      text: "带图片的消息",
      mediaArtifacts: [mediaArtifact],
      receivedAt: "2026-04-09T10:00:00.000Z"
    };

    const outbound: OutboundDraft = {
      draftId: "draft-1",
      sessionKey: inbound.sessionKey,
      text: "回一张图",
      mediaArtifacts: [mediaArtifact],
      createdAt: "2026-04-09T10:00:01.000Z"
    };

    const entry: ConversationEntry = {
      direction: "inbound",
      text: inbound.text,
      mediaArtifacts: [mediaArtifact],
      createdAt: inbound.receivedAt
    };

    expect(inbound.mediaArtifacts).toHaveLength(1);
    expect(outbound.mediaArtifacts?.[0].kind).toBe(MediaArtifactKind.Image);
    expect(entry.mediaArtifacts?.[0].originalName).toBe("cat.png");
  });

  it("exposes explicit QQ media ports", () => {
    expectTypeOf<QqMediaDownloadPort>().toMatchTypeOf<{
      downloadMediaArtifact(source: {
        sourceUrl: string;
        originalName?: string | null;
        mimeType?: string | null;
        fileSize?: number | null;
      }): Promise<{
        kind: string;
        sourceUrl: string;
        localPath: string;
        mimeType: string;
        fileSize: number;
        originalName: string;
        extractedText?: string | null;
      }>;
    }>();

    expectTypeOf<QqMediaSendPort>().toMatchTypeOf<{
      sendMedia(draft: {
        sessionKey: string;
        mediaArtifacts: Array<{
          kind: string;
          sourceUrl: string;
          localPath: string;
          mimeType: string;
          fileSize: number;
          originalName: string;
          extractedText?: string | null;
        }>;
      }): Promise<unknown>;
    }>();
  });
});
