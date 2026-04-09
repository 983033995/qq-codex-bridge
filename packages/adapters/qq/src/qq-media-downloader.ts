import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MediaArtifactKind, type MediaArtifact } from "../../../domain/src/message.js";
import type { QqMediaDownloadPort } from "../../../ports/src/qq.js";

type FetchLike = typeof fetch;

type QqMediaDownloaderOptions = {
  baseDir: string;
  fetchFn?: FetchLike;
};

export class QqMediaDownloader implements QqMediaDownloadPort {
  private readonly fetchFn: FetchLike;

  constructor(private readonly options: QqMediaDownloaderOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async downloadMediaArtifact(source: {
    sourceUrl: string;
    originalName?: string | null;
    mimeType?: string | null;
    fileSize?: number | null;
  }): Promise<MediaArtifact> {
    const normalizedSourceUrl = normalizeQqMediaUrl(source.sourceUrl);
    const response = await this.fetchFn(normalizedSourceUrl);
    if (!response.ok) {
      throw new Error(`QQ media download failed: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = this.resolveMimeType(source.mimeType, response.headers.get("content-type"));
    const originalName = this.resolveOriginalName(source.originalName, normalizedSourceUrl, mimeType);
    const artifact: MediaArtifact = {
      kind: inferMediaArtifactKind(originalName, mimeType),
      sourceUrl: normalizedSourceUrl,
      localPath: this.writeLocalFile(originalName, buffer),
      mimeType,
      fileSize: this.resolveFileSize(source.fileSize, response.headers.get("content-length"), buffer.length),
      originalName,
      extractedText: extractReadableText({
        kind: inferMediaArtifactKind(originalName, mimeType),
        originalName,
        mimeType,
        buffer
      })
    };

    return artifact;
  }

  private writeLocalFile(originalName: string, buffer: Buffer): string {
    const resolvedBaseDir = path.resolve(this.options.baseDir);
    mkdirSync(resolvedBaseDir, { recursive: true });
    const parsed = path.parse(originalName);
    const safeBaseName = sanitizeFileSegment(parsed.name || "qq-media");
    const ext = parsed.ext || "";
    const localPath = path.join(resolvedBaseDir, `${safeBaseName}-${randomUUID()}${ext}`);
    writeFileSync(localPath, buffer);
    return localPath;
  }

  private resolveMimeType(sourceMimeType: string | null | undefined, responseMimeType: string | null): string {
    const mimeType = sourceMimeType ?? responseMimeType ?? "application/octet-stream";
    return mimeType.split(";")[0]?.trim() || "application/octet-stream";
  }

  private resolveOriginalName(
    originalName: string | null | undefined,
    sourceUrl: string,
    mimeType: string
  ): string {
    if (originalName?.trim()) {
      return originalName.trim();
    }

    try {
      const url = new URL(sourceUrl);
      const urlName = path.basename(url.pathname);
      if (urlName && urlName !== "/") {
        return urlName;
      }
    } catch {
      // fall back to mime-derived extension
    }

    return `qq-media${extensionFromMimeType(mimeType)}`;
  }

  private resolveFileSize(
    sourceFileSize: number | null | undefined,
    contentLength: string | null,
    fallbackSize: number
  ): number {
    if (typeof sourceFileSize === "number" && Number.isFinite(sourceFileSize) && sourceFileSize >= 0) {
      return sourceFileSize;
    }

    const parsedContentLength = contentLength ? Number(contentLength) : Number.NaN;
    if (Number.isFinite(parsedContentLength) && parsedContentLength >= 0) {
      return parsedContentLength;
    }

    return fallbackSize;
  }
}

function normalizeQqMediaUrl(sourceUrl: string): string {
  if (sourceUrl.startsWith("//")) {
    return `https:${sourceUrl}`;
  }

  return sourceUrl;
}

function sanitizeFileSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function extensionFromMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "audio/mpeg":
      return ".mp3";
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    case "video/mp4":
      return ".mp4";
    default:
      return "";
  }
}

export function inferMediaArtifactKind(originalName: string, mimeType: string): MediaArtifactKind {
  if (mimeType.startsWith("image/")) {
    return MediaArtifactKind.Image;
  }

  if (mimeType.startsWith("audio/")) {
    return MediaArtifactKind.Audio;
  }

  if (mimeType.startsWith("video/")) {
    return MediaArtifactKind.Video;
  }

  const extension = path.extname(originalName).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(extension)) {
    return MediaArtifactKind.Image;
  }
  if ([".mp3", ".wav", ".ogg", ".aac", ".flac", ".silk"].includes(extension)) {
    return MediaArtifactKind.Audio;
  }
  if ([".mp4", ".mov", ".avi", ".mkv", ".webm"].includes(extension)) {
    return MediaArtifactKind.Video;
  }

  return MediaArtifactKind.File;
}

function extractReadableText(input: {
  kind: MediaArtifactKind;
  originalName: string;
  mimeType: string;
  buffer: Buffer;
}): string | null {
  if (isTextLikeArtifact(input.originalName, input.mimeType)) {
    const text = input.buffer.toString("utf8").trim();
    return text ? text.slice(0, 4000) : null;
  }

  switch (input.kind) {
    case MediaArtifactKind.Image:
      return `图片附件：${input.originalName}`;
    case MediaArtifactKind.Audio:
      return `语音附件：${input.originalName}`;
    case MediaArtifactKind.Video:
      return `视频附件：${input.originalName}`;
    case MediaArtifactKind.File:
      return `文件附件：${input.originalName}`;
    default:
      return null;
  }
}

function isTextLikeArtifact(originalName: string, mimeType: string): boolean {
  if (mimeType.startsWith("text/")) {
    return true;
  }

  if (["application/json", "application/xml"].includes(mimeType)) {
    return true;
  }

  const extension = path.extname(originalName).toLowerCase();
  return [".txt", ".md", ".json", ".csv", ".log", ".xml", ".yaml", ".yml"].includes(extension);
}
