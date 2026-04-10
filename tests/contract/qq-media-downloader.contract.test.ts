import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaArtifactKind } from "../../packages/domain/src/message.js";
import { QqMediaDownloader } from "../../packages/adapters/qq/src/qq-media-downloader.js";

describe("qq media downloader", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("downloads an attachment to the local runtime directory and infers image metadata", async () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "qq-media-downloader-"));
    tempDirs.push(baseDir);

    const fetchFn = vi.fn().mockResolvedValue(
      new Response(Buffer.from("png-bytes"), {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": "9"
        }
      })
    );

    const downloader = new QqMediaDownloader({
      baseDir,
      fetchFn
    });

    const artifact = await downloader.downloadMediaArtifact({
      sourceUrl: "https://example.com/cat.png",
      originalName: "cat.png",
      mimeType: "image/png",
      fileSize: 9
    });

    expect(artifact.kind).toBe(MediaArtifactKind.Image);
    expect(artifact.originalName).toBe("cat.png");
    expect(artifact.mimeType).toBe("image/png");
    expect(artifact.fileSize).toBe(9);
    expect(artifact.localPath.startsWith(baseDir)).toBe(true);
    expect(readFileSync(artifact.localPath, "utf8")).toBe("png-bytes");
  });

  it("extracts readable text from text-like attachments", async () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "qq-media-downloader-"));
    tempDirs.push(baseDir);

    const fetchFn = vi.fn().mockResolvedValue(
      new Response("第一行\n第二行", {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-length": "13"
        }
      })
    );

    const downloader = new QqMediaDownloader({
      baseDir,
      fetchFn
    });

    const artifact = await downloader.downloadMediaArtifact({
      sourceUrl: "https://example.com/note.txt",
      originalName: "note.txt",
      mimeType: "text/plain"
    });

    expect(artifact.kind).toBe(MediaArtifactKind.File);
    expect(artifact.extractedText).toContain("第一行");
    expect(artifact.extractedText).toContain("第二行");
  });

  it("normalizes protocol-relative qq attachment urls before downloading", async () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "qq-media-downloader-"));
    tempDirs.push(baseDir);

    const fetchFn = vi.fn().mockResolvedValue(
      new Response(Buffer.from("png-bytes"), {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": "9"
        }
      })
    );

    const downloader = new QqMediaDownloader({
      baseDir,
      fetchFn
    });

    const artifact = await downloader.downloadMediaArtifact({
      sourceUrl: "//gchat.qpic.cn/qqbot/cat.png",
      originalName: "cat.png",
      mimeType: "image/png"
    });

    expect(fetchFn).toHaveBeenCalledWith("https://gchat.qpic.cn/qqbot/cat.png");
    expect(artifact.sourceUrl).toBe("https://gchat.qpic.cn/qqbot/cat.png");
  });

  it("prefers stt transcription for voice attachments when configured", async () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "qq-media-downloader-"));
    tempDirs.push(baseDir);

    const mediaFetchFn = vi.fn().mockResolvedValue(
      new Response(Buffer.from("wav-bytes"), {
        status: 200,
        headers: {
          "content-type": "audio/wav",
          "content-length": "9"
        }
      })
    );
    const sttFetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "这是语音转写结果" }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      })
    );

    const downloader = new QqMediaDownloader({
      baseDir,
      fetchFn: mediaFetchFn,
      sttFetchFn,
      stt: {
        provider: "openai-compatible",
        baseUrl: "https://stt.example.com/v1",
        apiKey: "stt-key",
        model: "whisper-1"
      }
    });

    const artifact = await downloader.downloadMediaArtifact({
      sourceUrl: "https://example.com/voice.amr",
      voiceWavUrl: "https://example.com/voice.wav",
      asrReferText: "这是 QQ ASR 结果",
      originalName: "voice.amr",
      mimeType: "voice"
    });

    expect(mediaFetchFn).toHaveBeenCalledWith("https://example.com/voice.wav");
    expect(sttFetchFn).toHaveBeenCalledOnce();
    expect(artifact.kind).toBe(MediaArtifactKind.Audio);
    expect(artifact.transcript).toBe("这是语音转写结果");
    expect(artifact.transcriptSource).toBe("stt");
    expect(artifact.extractedText).toBe("这是语音转写结果");
  });

  it("falls back to qq asr text when stt is unavailable", async () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "qq-media-downloader-"));
    tempDirs.push(baseDir);

    const fetchFn = vi.fn().mockResolvedValue(
      new Response(Buffer.from("amr-bytes"), {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "9"
        }
      })
    );

    const downloader = new QqMediaDownloader({
      baseDir,
      fetchFn
    });

    const artifact = await downloader.downloadMediaArtifact({
      sourceUrl: "https://example.com/voice.amr",
      asrReferText: "这是回退的 ASR 文本",
      originalName: "voice.amr",
      mimeType: "voice"
    });

    expect(artifact.kind).toBe(MediaArtifactKind.Audio);
    expect(artifact.transcript).toBe("这是回退的 ASR 文本");
    expect(artifact.transcriptSource).toBe("asr");
    expect(artifact.extractedText).toBe("这是回退的 ASR 文本");
  });

  it("prefers qq asr fallback for amr voice when volcengine flash stt is configured", async () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "qq-media-downloader-"));
    tempDirs.push(baseDir);

    const fetchFn = vi.fn().mockResolvedValue(
      new Response(Buffer.from("amr-bytes"), {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "9"
        }
      })
    );
    const sttFetchFn = vi.fn();

    const downloader = new QqMediaDownloader({
      baseDir,
      fetchFn,
      sttFetchFn,
      stt: {
        provider: "volcengine-flash",
        endpoint: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
        appId: "8126477386",
        accessKey: "access-key",
        resourceId: "volc.bigasr.auc_turbo",
        model: "bigmodel"
      }
    });

    const artifact = await downloader.downloadMediaArtifact({
      sourceUrl: "https://example.com/voice.amr",
      asrReferText: "这是 QQ 返回的语音识别文本",
      originalName: "voice.amr",
      mimeType: "voice"
    });

    expect(sttFetchFn).not.toHaveBeenCalled();
    expect(artifact.transcript).toBe("这是 QQ 返回的语音识别文本");
    expect(artifact.transcriptSource).toBe("asr");
  });
});
