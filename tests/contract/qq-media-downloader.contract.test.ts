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
});
