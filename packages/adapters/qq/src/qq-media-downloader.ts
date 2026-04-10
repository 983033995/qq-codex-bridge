import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MediaArtifactKind, type MediaArtifact } from "../../../domain/src/message.js";
import type { QqMediaDownloadPort } from "../../../ports/src/qq.js";
import { type QqSttConfig, transcribeAudioFile } from "./qq-stt.js";

type FetchLike = typeof fetch;

type QqMediaDownloaderOptions = {
  baseDir: string;
  fetchFn?: FetchLike;
  sttFetchFn?: FetchLike;
  stt?: QqSttConfig | null;
};

export class QqMediaDownloader implements QqMediaDownloadPort {
  private readonly fetchFn: FetchLike;
  private readonly sttFetchFn: FetchLike;

  constructor(private readonly options: QqMediaDownloaderOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.sttFetchFn = options.sttFetchFn ?? fetch;
  }

  async downloadMediaArtifact(source: {
    sourceUrl: string;
    originalName?: string | null;
    mimeType?: string | null;
    fileSize?: number | null;
    voiceWavUrl?: string | null;
    asrReferText?: string | null;
  }): Promise<MediaArtifact> {
    const normalizedSourceUrl = normalizeQqMediaUrl(source.voiceWavUrl || source.sourceUrl);
    const response = await this.fetchFn(normalizedSourceUrl);
    if (!response.ok) {
      throw new Error(`QQ media download failed: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = this.resolveMimeType(source.mimeType, response.headers.get("content-type"));
    const originalName = this.resolveOriginalName(
      source.originalName,
      normalizedSourceUrl,
      mimeType,
      source.voiceWavUrl ?? null
    );
    const kind = inferMediaArtifactKind(originalName, mimeType);
    const localPath = this.writeLocalFile(originalName, buffer);
    const transcript = await this.resolveTranscript({
      kind,
      localPath,
      asrReferText: source.asrReferText
    });
    const artifact: MediaArtifact = {
      kind,
      sourceUrl: normalizedSourceUrl,
      localPath,
      mimeType,
      fileSize: this.resolveFileSize(source.fileSize, response.headers.get("content-length"), buffer.length),
      originalName,
      transcript: transcript?.text ?? null,
      transcriptSource: transcript?.source ?? null,
      extractedText: extractReadableText({
        kind,
        originalName,
        mimeType,
        buffer,
        transcript: transcript?.text ?? null
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
    mimeType: string,
    voiceWavUrl?: string | null
  ): string {
    if (voiceWavUrl) {
      const wavName = this.resolveNameFromUrl(voiceWavUrl);
      if (wavName) {
        return wavName;
      }
    }

    if (originalName?.trim()) {
      return originalName.trim();
    }

    const sourceName = this.resolveNameFromUrl(sourceUrl);
    if (sourceName) {
      return sourceName;
    }

    return `qq-media${extensionFromMimeType(mimeType)}`;
  }

  private resolveNameFromUrl(sourceUrl: string): string | null {
    try {
      const url = new URL(sourceUrl);
      const urlName = path.basename(url.pathname);
      if (urlName && urlName !== "/") {
        return urlName;
      }
    } catch {
      // fall back to mime-derived extension
    }

    return null;
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

  private async resolveTranscript(input: {
    kind: MediaArtifactKind;
    localPath: string;
    asrReferText?: string | null;
  }): Promise<{ text: string; source: "stt" | "asr" } | null> {
    if (input.kind !== MediaArtifactKind.Audio) {
      return null;
    }

    const asrReferText = input.asrReferText?.trim();
    const extension = path.extname(input.localPath).toLowerCase();
    const shouldPreferAsrFallback =
      this.options.stt?.provider === "volcengine-flash" &&
      [".amr", ".silk"].includes(extension) &&
      Boolean(asrReferText);

    if (this.options.stt && !shouldPreferAsrFallback) {
      const startedAt = Date.now();
      console.info("[qq-codex-bridge] qq stt started", {
        provider: this.options.stt.provider,
        file: input.localPath,
        extension,
        hasAsrReferText: Boolean(asrReferText)
      });
      try {
        const text = await transcribeAudioFile(input.localPath, this.options.stt, this.sttFetchFn);
        if (text) {
          console.info("[qq-codex-bridge] qq stt completed", {
            provider: this.options.stt.provider,
            file: input.localPath,
            durationMs: Date.now() - startedAt,
            transcriptPreview: text.slice(0, 80)
          });
          return {
            text,
            source: "stt"
          };
        }
        console.info("[qq-codex-bridge] qq stt produced no transcript", {
          provider: this.options.stt.provider,
          file: input.localPath,
          durationMs: Date.now() - startedAt
        });
      } catch (error) {
        console.error("[qq-codex-bridge] qq stt failed", {
          provider: this.options.stt.provider,
          error: error instanceof Error ? error.message : String(error),
          file: input.localPath,
          durationMs: Date.now() - startedAt
        });
      }
    }

    if (asrReferText) {
      console.info("[qq-codex-bridge] qq stt fallback used", {
        source: "asr",
        file: input.localPath,
        transcriptPreview: asrReferText.slice(0, 80)
      });
      return {
        text: asrReferText,
        source: "asr"
      };
    }

    return null;
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
  if ([".amr", ".mp3", ".wav", ".ogg", ".aac", ".flac", ".silk", ".m4a"].includes(extension)) {
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
  transcript?: string | null;
}): string | null {
  if (input.kind === MediaArtifactKind.Audio && input.transcript?.trim()) {
    return input.transcript.trim();
  }

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
