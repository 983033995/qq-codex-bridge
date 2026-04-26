import { describe, expect, it } from "vitest";
import { detectMode } from "../../packages/adapters/chatgpt-desktop/src/bridge-provider.js";

describe("chatgpt bridge provider", () => {
  it("detects Chinese image generation prompts as image mode", () => {
    expect(detectMode(
      "帮我生成摄影室写实全家福图片，温馨亲子家庭合影，简约纯色浅米色背景"
    )).toBe("image");
  });

  it("keeps ordinary Chinese chat prompts as text mode", () => {
    expect(detectMode("帮我总结一下这段话的重点")).toBe("text");
  });
});
