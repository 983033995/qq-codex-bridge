import { describe, expect, it } from "vitest";
import { parseAssistantReply } from "../../packages/adapters/codex-desktop/src/reply-parser.js";

describe("codex desktop driver contract", () => {
  it("extracts the latest assistant reply from a snapshot string", () => {
    const reply = parseAssistantReply(`
      User: hello
      Assistant: first reply
      Assistant: latest reply
    `);

    expect(reply).toBe("latest reply");
  });
});
