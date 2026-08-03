import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeishuIngress, normalizeFeishuInbound } from "../../packages/adapters/feishu/src/feishu-ingress.js";
import { FeishuPushEgress } from "../../packages/adapters/feishu/src/feishu-push-egress.js";
import type { FeishuMessageEvent } from "../../packages/adapters/feishu/src/feishu-types.js";

function event(overrides: Partial<FeishuMessageEvent> = {}): FeishuMessageEvent {
  return {
    event_id: "event-1",
    sender: { sender_type: "user", sender_id: { open_id: "ou-user" } },
    message: {
      message_id: "om-1",
      create_time: "1785751200000",
      chat_id: "oc-chat",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "hello" })
    },
    ...overrides
  };
}

describe("Feishu adapter", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

  it("normalizes text and rich post events into stable channel sessions", () => {
    expect(normalizeFeishuInbound(event(), "feishu:work")).toMatchObject({
      messageId: "om-1",
      accountKey: "feishu:work",
      sessionKey: "feishu:work::fs:group:oc-chat",
      peerKey: "fs:group:oc-chat",
      senderId: "ou-user",
      text: "hello"
    });
    expect(normalizeFeishuInbound(event({
      message: {
        ...event().message,
        message_id: "om-post",
        message_type: "post",
        content: JSON.stringify({ zh_cn: { title: "日报", content: [[{ tag: "text", text: "完成" }]] } })
      }
    }), "feishu:work")?.text).toBe("日报\n完成");
  });

  it("acknowledges events without awaiting business work, suppresses duplicates, and ignores bot senders", async () => {
    let receive!: (payload: FeishuMessageEvent) => void;
    const dispatcher = {
      register: vi.fn((handlers: { "im.message.receive_v1": (payload: FeishuMessageEvent) => void }) => {
        receive = handlers["im.message.receive_v1"];
      })
    };
    const wsClient = { start: vi.fn().mockResolvedValue(undefined), close: vi.fn() };
    const realIngress = new FeishuIngress({
      accountKey: "feishu:work",
      wsClient,
      eventDispatcher: dispatcher
    });
    let release!: () => void;
    const handled = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    realIngress.onMessage(handled);
    await realIngress.start();

    receive(event());
    expect(handled).toHaveBeenCalledTimes(1);
    receive(event());
    receive(event({ sender: { sender_type: "app", sender_id: { open_id: "bot" } } }));
    expect(handled).toHaveBeenCalledTimes(1);
    release();
    await Promise.resolve();
    await realIngress.stop();
    expect(wsClient.close).toHaveBeenCalledWith({ force: true });
  });

  it("sends rich text and images and rejects unsupported media before partial delivery", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-egress-"));
    roots.push(root);
    const imagePath = path.join(root, "report.png");
    fs.writeFileSync(imagePath, "png");
    const createMessage = vi.fn()
      .mockResolvedValueOnce({ code: 0, data: { message_id: "om-text" } })
      .mockResolvedValueOnce({ code: 0, data: { message_id: "om-image" } });
    const uploadImage = vi.fn().mockImplementation(async (input: {
      data: { image: AsyncIterable<Buffer> };
    }) => {
      for await (const _chunk of input.data.image) {
        // Consume the stream exactly as the SDK upload path does.
      }
      return { image_key: "img-key" };
    });
    const egress = new FeishuPushEgress({
      im: { message: { create: createMessage }, image: { create: uploadImage } }
    });
    const result = await egress.send({
      pushId: "push-feishu",
      target: {
        alias: "ops",
        channel: "feishu",
        accountKey: "feishu:work",
        targetType: "group",
        providerTargetId: "oc-chat",
        enabled: true,
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z"
      },
      payload: {
        message: { text: "**done**", format: "markdown", media: [{ type: "image", path: "report.png" }] },
        metadata: {}
      },
      resolvedMediaPaths: [imagePath]
    });
    expect(result).toEqual({ ok: true, providerMessageId: "om-image" });
    expect(createMessage.mock.calls[0][0].data.msg_type).toBe("post");
    expect(createMessage.mock.calls[1][0].data).toMatchObject({
      msg_type: "image",
      content: JSON.stringify({ image_key: "img-key" })
    });

    createMessage.mockClear();
    const unsupported = await egress.send({
      pushId: "push-file",
      target: {
        alias: "ops", channel: "feishu", accountKey: "feishu:work", targetType: "group",
        providerTargetId: "oc-chat", enabled: true,
        createdAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:00:00.000Z"
      },
      payload: {
        message: { text: "do not send", format: "plain", media: [{ type: "file", path: "report.pdf" }] },
        metadata: {}
      },
      resolvedMediaPaths: [path.join(root, "report.pdf")]
    });
    expect(unsupported).toMatchObject({ ok: false, code: "channel_unsupported" });
    expect(createMessage).not.toHaveBeenCalled();
  });
});
