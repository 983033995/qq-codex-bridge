import { describe, expect, it } from "vitest";
import { parseQqMediaSegments } from "../../packages/adapters/qq/src/qq-media-parser.js";

describe("qq media parser", () => {
  it("parses qqmedia tags into ordered text and media segments", () => {
    const segments = parseQqMediaSegments("这是图片\n<qqmedia>/tmp/cat.png</qqmedia>\n结束");

    expect(segments).toEqual([
      { type: "text", text: "这是图片\n" },
      { type: "media", reference: "/tmp/cat.png" },
      { type: "text", text: "\n结束" }
    ]);
  });

  it("parses markdown image and media links", () => {
    const segments = parseQqMediaSegments([
      "封面如下：",
      "![封面](/tmp/cover.png)",
      "[视频](https://example.com/demo.mp4)"
    ].join("\n"));

    expect(segments).toEqual([
      { type: "text", text: "封面如下：\n" },
      { type: "media", reference: "/tmp/cover.png" },
      { type: "text", text: "\n" },
      { type: "media", reference: "https://example.com/demo.mp4" }
    ]);
  });
});
