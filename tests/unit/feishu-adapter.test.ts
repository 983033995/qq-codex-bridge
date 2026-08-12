import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeishuIngress, normalizeFeishuInbound } from "../../packages/adapters/feishu/src/feishu-ingress.js";
import { buildFeishuPostContent } from "../../packages/adapters/feishu/src/feishu-message-client.js";
import { FeishuPushEgress } from "../../packages/adapters/feishu/src/feishu-push-egress.js";
import { FeishuSender, shouldUseFeishuRichText } from "../../packages/adapters/feishu/src/feishu-sender.js";
import type { FeishuMessageEvent } from "../../packages/adapters/feishu/src/feishu-types.js";
import { MediaArtifactKind } from "../../packages/domain/src/message.js";

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
      .mockResolvedValueOnce({ code: 0, data: { message_id: "om-image" } })
      .mockResolvedValueOnce({ code: 0, data: { message_id: "om-file" } })
      .mockResolvedValueOnce({ code: 0, data: { message_id: "om-audio" } });
    const uploadImage = vi.fn().mockImplementation(async (input: {
      data: { image: AsyncIterable<Buffer> };
    }) => {
      for await (const _chunk of input.data.image) {
        // Consume the stream exactly as the SDK upload path does.
      }
      return { image_key: "img-key" };
    });
    const uploadFile = vi.fn().mockImplementation(async (input: {
      data: { file: NodeJS.ReadableStream };
    }) => {
      await new Promise<void>((resolve) => {
        input.data.file.on("data", () => {});
        input.data.file.on("end", resolve);
        input.data.file.on("close", resolve);
      });
      return { file_key: "file-key" };
    });
    const egress = new FeishuPushEgress({
      im: { message: { create: createMessage }, image: { create: uploadImage }, file: { create: uploadFile } }
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
        message: {
          text: "活动线程\n\n| # | 线程 |\n| --- | --- |\n| 1 | vNext |",
          format: "markdown",
          media: [{ type: "image", path: "report.png" }]
        },
        metadata: {}
      },
      resolvedMediaPaths: [imagePath]
    });
    expect(result).toEqual({ ok: true, providerMessageId: "om-image" });
    expect(createMessage.mock.calls[0][0].data.msg_type).toBe("interactive");
    const card = JSON.parse(createMessage.mock.calls[0][0].data.content);
    expect(card).toMatchObject({
      schema: "2.0",
      body: {
        elements: [
          { tag: "markdown", content: "活动线程" },
          {
            tag: "table",
            page_size: 10,
            columns: [
              { name: "column_0", display_name: "#", data_type: "text" },
              { name: "column_1", display_name: "线程", data_type: "lark_md" }
            ],
            rows: [{ column_0: "1", column_1: "vNext" }]
          }
        ]
      }
    });
    expect(createMessage.mock.calls[1][0].data).toMatchObject({
      msg_type: "image",
      content: JSON.stringify({ image_key: "img-key" })
    });

    createMessage.mockClear();
    const filePath = path.join(root, "report.pdf");
    fs.writeFileSync(filePath, "pdf-bytes");
    const fileResult = await egress.send({
      pushId: "push-file",
      target: {
        alias: "ops", channel: "feishu", accountKey: "feishu:work", targetType: "group",
        providerTargetId: "oc-chat", enabled: true,
        createdAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:00:00.000Z"
      },
      payload: {
        message: { text: "", format: "plain", media: [{ type: "file", path: "report.pdf" }] },
        metadata: {}
      },
      resolvedMediaPaths: [filePath]
    });
    expect(fileResult).toEqual({ ok: true, providerMessageId: "om-file" });
    expect(uploadFile).toHaveBeenCalledWith({
      data: { file_type: "stream", file_name: "report.pdf", file: expect.anything() }
    });
    expect(createMessage.mock.calls[0][0].data).toMatchObject({
      msg_type: "file",
      content: JSON.stringify({ file_key: "file-key" })
    });

    createMessage.mockClear();
    const audioPath = path.join(root, "brief.opus");
    fs.writeFileSync(audioPath, "opus-bytes");
    const audioResult = await egress.send({
      pushId: "push-audio",
      target: {
        alias: "ops", channel: "feishu", accountKey: "feishu:work", targetType: "group",
        providerTargetId: "oc-chat", enabled: true,
        createdAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:00:00.000Z"
      },
      payload: {
        message: { text: "", format: "plain", media: [{ type: "audio", path: "brief.opus" }] },
        metadata: {}
      },
      resolvedMediaPaths: [audioPath]
    });
    expect(audioResult).toEqual({ ok: true, providerMessageId: "om-audio" });
    expect(uploadFile).toHaveBeenLastCalledWith({
      data: { file_type: "opus", file_name: "brief.opus", file: expect.anything() }
    });
    expect(createMessage.mock.calls[0][0].data).toMatchObject({
      msg_type: "audio",
      content: JSON.stringify({ file_key: "file-key" })
    });

    createMessage.mockClear();
    const unsupported = await egress.send({
      pushId: "push-sticker",
      target: {
        alias: "ops", channel: "feishu", accountKey: "feishu:work", targetType: "group",
        providerTargetId: "oc-chat", enabled: true,
        createdAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:00:00.000Z"
      },
      payload: {
        message: { text: "do not send", format: "plain", media: [{ type: "sticker" as never, path: "sticker.webp" }] },
        metadata: {}
      },
      resolvedMediaPaths: [path.join(root, "sticker.webp")]
    });
    expect(unsupported).toMatchObject({ ok: false, code: "channel_unsupported" });
    expect(createMessage).not.toHaveBeenCalled();
  });

  it("converts markdown structure into feishu post text/link tags without inventing unsupported style fields", () => {
    const post = buildFeishuPostContent(
      [
        "# 标题",
        "- 第一项",
        "- 第二项",
        "**重点** 和 `代码` 混排，还有 [文档](https://example.com/docs)"
      ].join("\n")
    );

    // Official Feishu guidance: use a single `md` paragraph for CommonMark/GFM.
    expect(post.zh_cn.title).toBe("标题");
    expect(post.zh_cn.content).toEqual([
      [{
        tag: "md",
        text: [
          "- 第一项",
          "- 第二项",
          "**重点** 和 `代码` 混排，还有 [文档](https://example.com/docs)"
        ].join("\n")
      }]
    ]);

    const plainLink = buildFeishuPostContent("[文档](https://example.com/docs)");
    expect(plainLink.zh_cn.content).toEqual([
      [{ tag: "a", text: "文档", href: "https://example.com/docs" }]
    ]);
  });

  it("treats markdown tables from /t as rich text and renders them via the post md tag", async () => {
    const tableText = [
      "最近 20 条最近有消息活动的 Codex 线程：",
      "",
      "| 序号 | 项目 | 线程标题 | 最近活动 |",
      "| --- | --- | --- | --- |",
      "| 👉🏻 1 | qq-codex-bridge | 使用 feishu-bot 发送消息 | 12 分钟前 |"
    ].join("\n");

    expect(shouldUseFeishuRichText(tableText)).toBe(true);
    expect(buildFeishuPostContent(tableText).zh_cn.content).toEqual([
      [{ tag: "md", text: tableText }]
    ]);

    const createMessage = vi.fn().mockResolvedValue({ code: 0, data: { message_id: "om-table" } });
    const sender = new FeishuSender({
      im: { message: { create: createMessage }, image: { create: vi.fn() }, file: { create: vi.fn() } }
    });
    await sender.deliver({
      draftId: "draft-table",
      sessionKey: "feishu:default::fs:c2c:oc-chat",
      text: tableText,
      createdAt: "2026-08-05T02:00:00.000Z"
    });

    expect(createMessage).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc-chat",
        msg_type: "post",
        content: JSON.stringify({
          zh_cn: {
            title: "",
            content: [[{ tag: "md", text: tableText }]]
          }
        }),
        uuid: "draft-table-text-0"
      }
    });
  });

  it("sends chat replies with real images inline and delivers other media kinds as real downloadable files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-sender-"));
    roots.push(root);
    const imagePath = path.join(root, "cover.png");
    fs.writeFileSync(imagePath, "png-bytes");
    const pdfPath = path.join(root, "report.pdf");
    fs.writeFileSync(pdfPath, "pdf-bytes");

    const createMessage = vi.fn()
      .mockResolvedValueOnce({ code: 0, data: { message_id: "om-text" } })
      .mockResolvedValueOnce({ code: 0, data: { message_id: "om-image" } })
      .mockResolvedValueOnce({ code: 0, data: { message_id: "om-file" } });
    const uploadImage = vi.fn().mockImplementation(async (input: {
      data: { image: AsyncIterable<Buffer> };
    }) => {
      for await (const _chunk of input.data.image) {
        // Consume the stream exactly as the SDK upload path does.
      }
      return { image_key: "img-key" };
    });
    const uploadFile = vi.fn().mockImplementation(async (input: {
      data: { file: NodeJS.ReadableStream };
    }) => {
      await new Promise<void>((resolve) => {
        input.data.file.on("data", () => {});
        input.data.file.on("end", resolve);
        input.data.file.on("close", resolve);
      });
      return { file_key: "file-key" };
    });
    const sender = new FeishuSender({
      im: { message: { create: createMessage }, image: { create: uploadImage }, file: { create: uploadFile } }
    });

    const result = await sender.deliver({
      draftId: "draft-1",
      sessionKey: "feishu:work::fs:c2c:ou-user",
      text: `这是封面：\n![封面](${imagePath})`,
      mediaArtifacts: [
        {
          kind: MediaArtifactKind.File,
          sourceUrl: "",
          localPath: pdfPath,
          mimeType: "application/pdf",
          fileSize: 10,
          originalName: "report.pdf"
        }
      ],
      createdAt: "2026-08-04T00:00:00.000Z"
    });

    expect(result.providerMessageId).toBe("om-file");
    expect(createMessage.mock.calls[0][0].data.msg_type).toBe("text");
    expect(createMessage.mock.calls[1][0].data).toMatchObject({
      msg_type: "image",
      content: JSON.stringify({ image_key: "img-key" })
    });
    expect(createMessage.mock.calls[2][0].data).toMatchObject({
      msg_type: "file",
      content: JSON.stringify({ file_key: "file-key" })
    });
    expect(uploadFile).toHaveBeenCalledWith({
      data: { file_type: "stream", file_name: "report.pdf", file: expect.anything() }
    });
    expect(uploadImage).toHaveBeenCalledTimes(1);
  });
});
