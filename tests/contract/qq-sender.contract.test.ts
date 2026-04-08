import { describe, expect, it } from "vitest";
import { chunkTextForQq } from "../../packages/adapters/qq/src/qq-sender.js";

describe("qq sender", () => {
  it("splits long text into 5000-char chunks", () => {
    const text = "a".repeat(10020);
    const chunks = chunkTextForQq(text, 5000);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(5000);
    expect(chunks[1]).toHaveLength(5000);
    expect(chunks[2]).toHaveLength(20);
  });
});
