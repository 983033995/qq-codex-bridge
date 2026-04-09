import { describe, expect, it } from "vitest";
import { isLikelyComposerSubmitButton } from "../../packages/adapters/codex-desktop/src/composer-heuristics.js";

describe("composer heuristics", () => {
  it("matches explicit send labels", () => {
    expect(
      isLikelyComposerSubmitButton({
        text: "发送",
        aria: null,
        title: null,
        className: ""
      })
    ).toBe(true);
  });

  it("matches Codex's icon-only primary composer action button", () => {
    expect(
      isLikelyComposerSubmitButton({
        text: "",
        aria: null,
        title: null,
        className:
          "focus-visible:outline-token-button-background size-token-button-composer bg-token-foreground"
      })
    ).toBe(true);
  });

  it("does not match unrelated composer controls", () => {
    expect(
      isLikelyComposerSubmitButton({
        text: "",
        aria: "听写",
        title: null,
        className: "h-token-button-composer"
      })
    ).toBe(false);
  });
});
