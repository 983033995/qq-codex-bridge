import path from "node:path";
import { MediaArtifactKind, type MediaArtifact } from "../../../domain/src/message.js";
import { inferMediaArtifactKind } from "./qq-media-downloader.js";

export type QqMediaSegment =
  | { type: "text"; text: string }
  | { type: "media"; reference: string };

const MEDIA_SEGMENT_PATTERN =
  /<qqmedia>([\s\S]*?)<\/qqmedia>|!\[[^\]]*\]\(([^)]+)\)|\[[^\]]+\]\(([^)]+)\)/g;

export function parseQqMediaSegments(text: string): QqMediaSegment[] {
  if (!text) {
    return [];
  }

  const segments: QqMediaSegment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(MEDIA_SEGMENT_PATTERN)) {
    const fullMatch = match[0];
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) {
      segments.push({ type: "text", text: text.slice(lastIndex, matchIndex) });
    }

    const reference = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (reference && isSupportedMediaReference(reference)) {
      segments.push({ type: "media", reference });
    } else {
      segments.push({ type: "text", text: fullMatch });
    }

    lastIndex = matchIndex + fullMatch.length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", text: text.slice(lastIndex) });
  }

  return mergeAdjacentTextSegments(segments);
}

export function buildMediaArtifactFromReference(reference: string): MediaArtifact {
  const mimeType = inferMimeType(reference);
  const originalName = inferOriginalName(reference);

  return {
    kind: inferMediaArtifactKind(originalName, mimeType),
    sourceUrl: reference,
    localPath: reference,
    mimeType,
    fileSize: 0,
    originalName
  };
}

function mergeAdjacentTextSegments(segments: QqMediaSegment[]): QqMediaSegment[] {
  const merged: QqMediaSegment[] = [];

  for (const segment of segments) {
    const previous = merged.at(-1);
    if (segment.type === "text" && previous?.type === "text") {
      previous.text += segment.text;
      continue;
    }
    if (segment.type === "text" && segment.text.length === 0) {
      continue;
    }
    merged.push(segment);
  }

  return merged;
}

function isSupportedMediaReference(reference: string): boolean {
  return hasRecognizedExtension(reference) || reference.startsWith("/") || reference.startsWith("http://") || reference.startsWith("https://");
}

function hasRecognizedExtension(reference: string): boolean {
  const extension = path.extname(stripQuery(reference)).toLowerCase();
  return [
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
    ".mp3", ".wav", ".ogg", ".aac", ".flac", ".silk",
    ".mp4", ".mov", ".avi", ".mkv", ".webm",
    ".pdf", ".txt", ".md", ".json", ".csv", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".zip"
  ].includes(extension);
}

function inferMimeType(reference: string): string {
  const extension = path.extname(stripQuery(reference)).toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".ogg":
      return "audio/ogg";
    case ".aac":
      return "audio/aac";
    case ".flac":
      return "audio/flac";
    case ".silk":
      return "audio/silk";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".avi":
      return "video/x-msvideo";
    case ".mkv":
      return "video/x-matroska";
    case ".webm":
      return "video/webm";
    case ".txt":
      return "text/plain";
    case ".md":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".csv":
      return "text/csv";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

function inferOriginalName(reference: string): string {
  try {
    const url = new URL(reference);
    const name = path.basename(url.pathname);
    return name || "qq-media";
  } catch {
    return path.basename(reference) || "qq-media";
  }
}

function stripQuery(reference: string): string {
  return reference.split("?")[0] ?? reference;
}
