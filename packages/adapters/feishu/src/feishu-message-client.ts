import fs from "node:fs";
import type { FeishuMessageClient } from "./feishu-types.js";

export async function sendFeishuText(
  client: FeishuMessageClient,
  targetId: string,
  text: string,
  options: { rich?: boolean; uuid?: string } = {}
): Promise<string | null> {
  const result = await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: targetId,
      msg_type: options.rich ? "post" : "text",
      content: options.rich ? buildPostContent(text) : JSON.stringify({ text }),
      ...(options.uuid ? { uuid: options.uuid } : {})
    }
  });
  assertFeishuResponse(result.code, result.msg);
  return result.data?.message_id ?? null;
}

export async function sendFeishuImage(
  client: FeishuMessageClient,
  targetId: string,
  imagePath: string,
  uuid?: string
): Promise<string | null> {
  const uploaded = await client.im.image.create({
    data: { image_type: "message", image: fs.createReadStream(imagePath) }
  });
  const imageKey = uploaded?.image_key;
  if (!imageKey) {
    throw new Error("Feishu image upload returned no image_key");
  }
  const result = await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: targetId,
      msg_type: "image",
      content: JSON.stringify({ image_key: imageKey }),
      ...(uuid ? { uuid } : {})
    }
  });
  assertFeishuResponse(result.code, result.msg);
  return result.data?.message_id ?? null;
}

function buildPostContent(text: string): string {
  return JSON.stringify({
    zh_cn: {
      title: "",
      content: [[{ tag: "text", text }]]
    }
  });
}

function assertFeishuResponse(code?: number, message?: string): void {
  if (typeof code === "number" && code !== 0) {
    throw new Error(`Feishu API failed: ${code} ${message ?? "unknown error"}`);
  }
}
