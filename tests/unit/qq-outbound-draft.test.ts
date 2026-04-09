import { describe, expect, it } from "vitest";
import { MediaArtifactKind } from "../../packages/domain/src/message.js";
import { enrichQqOutboundDraft } from "../../packages/orchestrator/src/qq-outbound-draft.js";

describe("qq outbound draft", () => {
  it("adds media artifacts parsed from qqmedia declarations into the outbound draft", () => {
    const draft = enrichQqOutboundDraft({
      draftId: "draft-qq-outbound",
      sessionKey: "qqbot:default::qq:c2c:abc",
      text: "图片如下：\n<qqmedia>/tmp/cat.png</qqmedia>",
      createdAt: "2026-04-09T18:10:00.000Z"
    });

    expect(draft.mediaArtifacts).toEqual([
      expect.objectContaining({
        kind: MediaArtifactKind.Image,
        localPath: "/tmp/cat.png",
        sourceUrl: "/tmp/cat.png"
      })
    ]);
  });
});
