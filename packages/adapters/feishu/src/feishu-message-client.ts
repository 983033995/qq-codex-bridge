import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { FeishuMessageClient } from "./feishu-types.js";

const execFileAsync = promisify(execFile);

export async function sendFeishuText(
  client: FeishuMessageClient,
  targetId: string,
  text: string,
  options: { rich?: boolean; interactive?: boolean; uuid?: string } = {}
): Promise<string | null> {
  const richType = options.interactive ? "interactive" : "post";
  const result = await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: targetId,
      msg_type: options.rich ? richType : "text",
      content: options.rich
        ? options.interactive ? buildInteractiveCard(text) : buildPostContent(text)
        : JSON.stringify({ text }),
      ...(options.uuid ? { uuid: options.uuid } : {})
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

export async function sendFeishuImage(
  client: FeishuMessageClient,
  targetId: string,
  imagePathOrUrl: string,
  uuid?: string,
  fetchFn: typeof fetch = fetch
): Promise<string | null> {
  const uploaded = await client.im.image.create({
    data: { image_type: "message", image: await loadFeishuImageSource(imagePathOrUrl, fetchFn) }
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

async function loadFeishuImageSource(
  pathOrUrl: string,
  fetchFn: typeof fetch
): Promise<Buffer | fs.ReadStream> {
  if (/^https?:\/\//i.test(pathOrUrl)) {
    const response = await fetchFn(pathOrUrl);
    if (!response.ok) {
      throw new Error(`Feishu image download failed: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
  return fs.createReadStream(pathOrUrl);
}

/**
 * Uploads and sends a generic file (or a real, playable audio/video file) via
 * Feishu's `im/v1/files` + `im/v1/messages` (msg_type=file) APIs. Feishu's
 * file upload endpoint accepts a small set of `file_type` values; "stream" is
 * the documented catch-all that accepts arbitrary binary content and renders
 * as a downloadable file card, so it is used for every kind except audio
 * (which Feishu expects as an Opus-encoded voice note under `file_type:
 * "opus"`; non-opus audio still uploads fine as "stream").
 */
export async function sendFeishuFile(
  client: FeishuMessageClient,
  targetId: string,
  filePathOrUrl: string,
  fileName: string,
  uuid?: string,
  fetchFn: typeof fetch = fetch
): Promise<string | null> {
  const uploaded = await client.im.file.create({
    data: {
      file_type: "stream",
      file_name: fileName,
      file: await loadFeishuImageSource(filePathOrUrl, fetchFn)
    }
  });
  const fileKey = uploaded?.file_key;
  if (!fileKey) {
    throw new Error("Feishu file upload returned no file_key");
  }
  const result = await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: targetId,
      msg_type: "file",
      content: JSON.stringify({ file_key: fileKey }),
      ...(uuid ? { uuid } : {})
    }
  });
  assertFeishuResponse(result.code, result.msg);
  return result.data?.message_id ?? null;
}

export async function sendFeishuAudio(
  client: FeishuMessageClient,
  targetId: string,
  audioPath: string,
  uuid?: string
): Promise<string | null> {
  const { opusPath, temporary } = await ensureOpusAudio(audioPath);
  try {
    const uploaded = await client.im.file.create({
      data: {
        file_type: "opus",
        file_name: path.basename(opusPath),
        file: fs.createReadStream(opusPath)
      }
    });
    const fileKey = uploaded?.file_key;
    if (!fileKey) {
      throw new Error("Feishu audio upload returned no file_key");
    }
    const result = await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: targetId,
        msg_type: "audio",
        content: JSON.stringify({ file_key: fileKey }),
        ...(uuid ? { uuid } : {})
      }
    });
    assertFeishuResponse(result.code, result.msg);
    return result.data?.message_id ?? null;
  } finally {
    if (temporary) {
      fs.rmSync(opusPath, { force: true });
    }
  }
}

async function ensureOpusAudio(audioPath: string): Promise<{ opusPath: string; temporary: boolean }> {
  if (path.extname(audioPath).toLowerCase() === ".opus") {
    return { opusPath: audioPath, temporary: false };
  }
  const opusPath = path.join(os.tmpdir(), `qq-codex-feishu-${randomUUID()}.opus`);
  try {
    await execFileAsync("ffmpeg", [
      "-v", "error",
      "-y",
      "-i", audioPath,
      "-c:a", "libopus",
      "-b:a", "32k",
      "-ac", "1",
      "-ar", "48000",
      opusPath
    ]);
    return { opusPath, temporary: true };
  } catch (error) {
    fs.rmSync(opusPath, { force: true });
    throw new Error(
      `Feishu audio conversion to Opus failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

/**
 * Converts Markdown-ish text into a Feishu "post" rich-text payload.
 *
 * Official Feishu docs recommend the `md` tag for Markdown (CommonMark 0.31 +
 * GFM: headings, lists, tables, code fences, bold/italic, links, etc.). The
 * `md` tag occupies one or more paragraphs and cannot share a line with other
 * tags, so we emit a single `md` paragraph for rich content. Short plain text
 * that only needs a hyperlink still uses the classic `text`/`a` tags.
 */
export function buildFeishuPostContent(text: string): {
  zh_cn: { title: string; content: FeishuPostTag[][] };
} {
  const normalized = text.replace(/\r\n/g, "\n");
  const title = extractFeishuTitle(normalized);
  const body = title ? stripLeadingTitleLine(normalized) : normalized.trim();

  if (!body) {
    return {
      zh_cn: {
        title,
        content: [[{ tag: "text", text: "" }]]
      }
    };
  }

  // Prefer the official Markdown renderer whenever the body has structure
  // beyond a single plain paragraph (or always for multi-line / styled text).
  if (shouldRenderFeishuMarkdown(body)) {
    return {
      zh_cn: {
        title,
        content: [[{ tag: "md", text: body }]]
      }
    };
  }

  return {
    zh_cn: {
      title,
      content: [tokenizeFeishuLine(body)]
    }
  };
}

export type FeishuPostTag =
  | { tag: "text"; text: string; style?: Array<"bold" | "italic" | "underline" | "lineThrough"> }
  | { tag: "a"; text: string; href: string; style?: Array<"bold" | "italic" | "underline" | "lineThrough"> }
  | { tag: "md"; text: string };

function extractFeishuTitle(text: string): string {
  const firstLine = text.split("\n").find((line) => line.trim())?.trim() ?? "";
  const heading = /^\s{0,3}#{1,6}\s+(.+)$/.exec(firstLine);
  if (!heading?.[1]) {
    return "";
  }
  return heading[1].trim().slice(0, 50);
}

function stripLeadingTitleLine(text: string): string {
  const lines = text.split("\n");
  const firstIndex = lines.findIndex((line) => line.trim());
  if (firstIndex < 0) {
    return "";
  }
  if (!/^\s{0,3}#{1,6}\s+/.test(lines[firstIndex] ?? "")) {
    return text.trim();
  }
  return [...lines.slice(0, firstIndex), ...lines.slice(firstIndex + 1)].join("\n").trim();
}

function shouldRenderFeishuMarkdown(text: string): boolean {
  // Single-line link-only text stays on classic `text`/`a` tags; structured
  // Markdown (multi-line, headings, lists, emphasis, fences, tables, quotes)
  // goes through the official `md` renderer.
  return (
    text.includes("\n")
    || /^\s{0,3}#{1,6}\s/m.test(text)
    || /^\s*[-*+]\s/m.test(text)
    || /^\s*\d+\.\s/m.test(text)
    || /\*\*[^*]+\*\*/.test(text)
    || /```[\s\S]*```/.test(text)
    || /\|.+\|/.test(text)
    || /^\s*>\s/m.test(text)
  );
}

const FEISHU_LINK_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

function tokenizeFeishuLine(line: string): FeishuPostTag[] {
  const tags: FeishuPostTag[] = [];
  let lastIndex = 0;

  for (const match of line.matchAll(FEISHU_LINK_PATTERN)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) {
      tags.push({ tag: "text", text: line.slice(lastIndex, matchIndex) });
    }
    tags.push({ tag: "a", text: match[1]!, href: match[2]! });
    lastIndex = matchIndex + match[0].length;
  }

  if (lastIndex < line.length || tags.length === 0) {
    tags.push({ tag: "text", text: line.slice(lastIndex) });
  }

  return tags;
}

function buildPostContent(text: string): string {
  return JSON.stringify(buildFeishuPostContent(text));
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
