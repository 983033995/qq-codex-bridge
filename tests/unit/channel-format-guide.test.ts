import { describe, expect, it } from "vitest";
import {
  CHANNEL_FORMAT_GUIDES,
  enrichPushTargetsWithFormatGuide,
  getChannelFormatGuide,
  listChannelFormatGuides,
  resolveChannelFormatGuide
} from "../../apps/mcp-server/src/channel-format-guide.js";

describe("channel format guide", () => {
  it("exposes complete guides for feishu, weixin, and qq", () => {
    expect(Object.keys(CHANNEL_FORMAT_GUIDES).sort()).toEqual(["feishu", "qq", "weixin"]);
    for (const channel of ["feishu", "weixin", "qq"] as const) {
      const guide = getChannelFormatGuide(channel);
      expect(guide.channel).toBe(channel);
      expect(["plain", "markdown"]).toContain(guide.recommendedFormat);
      expect(guide.supportedFormats.length).toBeGreaterThan(0);
      expect(guide.summary.length).toBeGreaterThan(0);
      expect(guide.capabilities.length).toBeGreaterThan(0);
      expect(guide.limitations.length).toBeGreaterThan(0);
      expect(guide.writingTips.length).toBeGreaterThan(0);
      expect(guide.mediaNotes.length).toBeGreaterThan(0);
    }
  });

  it("recommends markdown for feishu and plain for weixin/qq", () => {
    expect(getChannelFormatGuide("feishu").recommendedFormat).toBe("markdown");
    expect(getChannelFormatGuide("weixin").recommendedFormat).toBe("plain");
    expect(getChannelFormatGuide("qq").recommendedFormat).toBe("plain");
  });

  it("lists all guides and resolves by channel or target alias", () => {
    expect(listChannelFormatGuides().map((guide) => guide.channel).sort()).toEqual([
      "feishu",
      "qq",
      "weixin"
    ]);
    expect(
      resolveChannelFormatGuide({
        channel: "feishu",
        targets: [{ alias: "feishu-bot", channel: "weixin" }]
      })?.channel
    ).toBe("feishu");
    expect(
      resolveChannelFormatGuide({
        target: "feishu-bot",
        targets: [{ alias: "feishu-bot", channel: "feishu" }]
      })?.channel
    ).toBe("feishu");
    expect(
      resolveChannelFormatGuide({
        target: "missing",
        targets: [{ alias: "feishu-bot", channel: "feishu" }]
      })
    ).toBeNull();
  });

  it("enriches push target list payloads with recommended format fields", () => {
    const enriched = enrichPushTargetsWithFormatGuide({
      targets: [
        { alias: "feishu-bot", channel: "feishu", enabled: true },
        { alias: "weixin-bot", channel: "weixin", enabled: true }
      ]
    });
    expect(enriched.targets[0]).toMatchObject({
      alias: "feishu-bot",
      channel: "feishu",
      recommendedFormat: "markdown",
      formatSummary: expect.stringContaining("飞书")
    });
    expect(enriched.targets[1]).toMatchObject({
      alias: "weixin-bot",
      recommendedFormat: "plain"
    });
  });
});
