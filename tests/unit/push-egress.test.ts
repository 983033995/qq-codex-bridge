import { describe, expect, it, vi } from "vitest";
import { QqPushEgress } from "../../packages/adapters/qq/src/qq-push-egress.js";
import { WeixinPushEgress } from "../../packages/adapters/weixin/src/weixin-push-egress.js";

const input = {
  pushId: "push-1",
  target: {
    alias: "target",
    channel: "weixin" as const,
    accountKey: "weixin:default",
    targetType: "group" as const,
    providerTargetId: "group-1",
    enabled: true,
    createdAt: "2026-08-03T10:00:00.000Z",
    updatedAt: "2026-08-03T10:00:00.000Z"
  },
  payload: {
    message: { text: "done", format: "plain" as const, media: [] },
    metadata: {}
  },
  resolvedMediaPaths: []
};

describe("push egress adapters", () => {
  it("never fabricates a QQ reply message id", async () => {
    await expect(new QqPushEgress().send()).resolves.toEqual(expect.objectContaining({
      ok: false,
      retryable: false,
      code: "channel_unsupported"
    }));
  });

  it("classifies Weixin 429 as retryable and other 4xx as permanent", async () => {
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error("Weixin message send failed: 429 busy"))
      .mockRejectedValueOnce(new Error("Weixin message send failed: 403 forbidden"))
      .mockResolvedValueOnce("wx-message");
    const egress = new WeixinPushEgress({ sendMessage });

    await expect(egress.send(input)).resolves.toMatchObject({
      ok: false,
      retryable: true,
      code: "rate_limited"
    });
    await expect(egress.send(input)).resolves.toMatchObject({
      ok: false,
      retryable: false,
      code: "permanent_failure"
    });
    await expect(egress.send(input)).resolves.toEqual({
      ok: true,
      providerMessageId: "wx-message"
    });
    expect(sendMessage).toHaveBeenLastCalledWith(expect.not.objectContaining({ replyToMessageId: expect.anything() }));
  });
});
