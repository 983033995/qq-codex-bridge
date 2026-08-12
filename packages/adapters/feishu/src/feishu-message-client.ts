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
      msg_type: options.rich ? "interactive" : "text",
      content: options.rich ? buildInteractiveCard(text) : JSON.stringify({ text }),
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

function buildInteractiveCard(text: string): string {
  const table = parseMarkdownTable(text);
  const elements: unknown[] = [];
  if (table?.prefix) {
    elements.push({ tag: "markdown", content: table.prefix });
  }
  if (table) {
    elements.push({
      tag: "table",
      page_size: 10,
      row_height: "low",
      freeze_first_column: true,
      header_style: {
        background_style: "grey",
        bold: true,
        text_align: "left",
        text_size: "normal"
      },
      columns: table.headers.map((header, index) => ({
        name: `column_${index}`,
        display_name: header,
        data_type: index === 0 ? "text" : "lark_md",
        width: index === 0 ? "80px" : "auto",
        vertical_align: "top"
      })),
      rows: table.rows.map((row) => Object.fromEntries(
        table.headers.map((_header, index) => [`column_${index}`, row[index] ?? ""])
      ))
    });
    if (table.suffix) {
      elements.push({ tag: "markdown", content: table.suffix });
    }
  } else {
    elements.push({ tag: "markdown", content: text });
  }
  return JSON.stringify({
    schema: "2.0",
    config: { update_multi: true },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements
    }
  });
}

function parseMarkdownTable(text: string): {
  prefix: string;
  suffix: string;
  headers: string[];
  rows: string[][];
} | null {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length - 1; index += 1) {
    const headers = splitMarkdownRow(lines[index]!);
    const separator = splitMarkdownRow(lines[index + 1]!);
    if (!headers || !separator || headers.length !== separator.length) continue;
    if (!separator.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")))) continue;
    const rows: string[][] = [];
    let rowEnd = index + 2;
    for (; rowEnd < lines.length; rowEnd += 1) {
      const row = splitMarkdownRow(lines[rowEnd]!);
      if (!row) break;
      rows.push(row);
    }
    if (rows.length === 0) return null;
    return {
      prefix: lines.slice(0, index).join("\n").trim(),
      suffix: lines.slice(rowEnd).join("\n").trim(),
      headers,
      rows
    };
  }
  return null;
}

function splitMarkdownRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of trimmed.slice(1, -1)) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return cells;
}

function assertFeishuResponse(code?: number, message?: string): void {
  if (typeof code === "number" && code !== 0) {
    throw new Error(`Feishu API failed: ${code} ${message ?? "unknown error"}`);
  }
}
