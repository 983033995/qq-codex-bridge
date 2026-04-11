import { describe, expect, it } from "vitest";
import { MediaArtifactKind } from "../../packages/domain/src/message.js";
import {
  formatQqOutboundDraft,
  formatQqOutboundText
} from "../../packages/orchestrator/src/qq-outbound-format.js";

describe("qq outbound format", () => {
  it("drops internal bridge path explanations when the media artifact is already attached", () => {
    const formatted = formatQqOutboundDraft({
      draftId: "draft-format-1",
      sessionKey: "qqbot:default::qq:c2c:abc",
      text: [
        "你贴出来的这个：",
        "runtime/media/demo.png",
        "它是 QQBot 桥接程序收到你上传附件后，临时落盘的运行目录路径，而且这里看到的是相对路径。",
        "真正给你的图片如下。"
      ].join("\n"),
      mediaArtifacts: [
        {
          kind: MediaArtifactKind.Image,
          sourceUrl: "/Volumes/demo.png",
          localPath: "runtime/media/demo.png",
          mimeType: "image/png",
          fileSize: 0,
          originalName: "demo.png"
        }
      ],
      createdAt: "2026-04-09T19:10:00.000Z"
    });

    expect(formatted.text).toContain("你贴出来的这个：");
    expect(formatted.text).toContain("真正给你的图片如下。");
    expect(formatted.text).not.toContain("runtime/media/demo.png");
    expect(formatted.text).not.toContain("临时落盘的运行目录路径");
  });

  it("preserves markdown tables for downstream markdown delivery", () => {
    const formatted = formatQqOutboundText(
      [
        "| 路径 | 含义 |",
        "| --- | --- |",
        "| runtime/media/... | QQ 桥接缓存附件路径 |",
        "| /Volumes/demo.png | 本地真实文件路径 |"
      ].join("\n"),
      []
    );

    expect(formatted).toContain("| 路径 | 含义 |");
    expect(formatted).toContain("| runtime/media/... | QQ 桥接缓存附件路径 |");
    expect(formatted).toContain("| /Volumes/demo.png | 本地真实文件路径 |");
  });

  it("preserves indentation and fenced code blocks", () => {
    const formatted = formatQqOutboundText(
      [
        "下面给你一段 JavaScript 闭包示例代码：",
        "",
        "```javascript",
        "function createCounter() {",
        "  let count = 0;",
        "",
        "  return function () {",
        "    count++;",
        "    return count;",
        "  };",
        "}",
        "```"
      ].join("\n"),
      []
    );

    expect(formatted).toContain("```javascript");
    expect(formatted).toContain("  let count = 0;");
    expect(formatted).toContain("    count++;");
  });
});
