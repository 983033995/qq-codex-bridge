import { describe, expect, it, vi } from "vitest";
import { QqSender, chunkTextForQq } from "../../packages/adapters/qq/src/qq-sender.js";

describe("qq sender", () => {
  it("splits long text into 5000-char chunks", () => {
    const text = "a".repeat(10020);
    const chunks = chunkTextForQq(text, 5000);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(5000);
    expect(chunks[1]).toHaveLength(5000);
    expect(chunks[2]).toHaveLength(20);
  });

  it("routes c2c drafts through the qq api client", async () => {
    const apiClient = {
      sendC2CMessage: vi.fn().mockResolvedValue("qq-msg-1"),
      sendGroupMessage: vi.fn()
    };
    const sender = new QqSender(apiClient);

    await expect(
      sender.deliver({
        draftId: "draft-1",
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        text: "hello",
        createdAt: "2026-04-09T10:00:00.000Z"
      })
    ).resolves.toEqual({
      jobId: "draft-1",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      providerMessageId: "qq-msg-1",
      deliveredAt: "2026-04-09T10:00:00.000Z"
    });

    expect(apiClient.sendC2CMessage).toHaveBeenCalledWith("OPENID123", "hello", "draft-1");
    expect(apiClient.sendGroupMessage).not.toHaveBeenCalled();
  });
});
