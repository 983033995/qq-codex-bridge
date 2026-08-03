import { describe, expect, it } from "vitest";
import {
  collectMediaReferences,
  collectMediaReferencesFromText,
  normalizeMediaReference
} from "../../packages/adapters/codex-desktop/src/image-collector.js";

describe("unified desktop image collector", () => {
  it("normalizes and stably deduplicates references from multiple transports", () => {
    expect(collectMediaReferences(
      [" /tmp/report.png ", "file:///tmp/report.png"],
      ["https://example.com/result.webp", "/tmp/report.png"]
    )).toEqual([
      "/tmp/report.png",
      "https://example.com/result.webp"
    ]);
  });

  it("collects media tags from AppServer and rollout text", () => {
    expect(collectMediaReferencesFromText([
      "任务完成",
      "<qqmedia>/tmp/result.png</qqmedia>",
      "<qqmedia> /tmp/result.png </qqmedia>",
      "<qqmedia>file:///tmp/chart%20final.png</qqmedia>"
    ].join("\n"))).toEqual([
      "/tmp/result.png",
      "/tmp/chart final.png"
    ]);
  });

  it("accepts explicit extensionless file URLs and inline images before media filtering", () => {
    expect(collectMediaReferencesFromText([
      "<qqmedia>FILE:///tmp/result-without-extension</qqmedia>",
      "<qqmedia>data:image/png;base64,aGVsbG8=</qqmedia>",
      "![inline](data:image/png;base64,d29ybGQ=)",
      "![remote](https://example.com/not-routed.png)"
    ].join("\n"))).toEqual([
      "/tmp/result-without-extension",
      "data:image/png;base64,aGVsbG8=",
      "data:image/png;base64,d29ybGQ="
    ]);
  });

  it("rejects empty, non-string, and malformed file references", () => {
    expect(collectMediaReferences([
      "",
      "   ",
      null,
      42,
      "file://%zz",
      "blob:https://app.local/generated-image"
    ])).toEqual([]);
    expect(normalizeMediaReference(undefined)).toBeNull();
  });
});
