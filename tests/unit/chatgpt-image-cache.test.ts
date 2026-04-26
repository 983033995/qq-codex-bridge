import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  diffCache,
  snapshotCache
} from "../../packages/adapters/chatgpt-desktop/src/image-cache.js";

const pngHeader = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);

function writePng(filePath: string): void {
  writeFileSync(filePath, Buffer.concat([pngHeader, Buffer.alloc(60_000)]));
}

describe("chatgpt image cache", () => {
  const tempDirs: string[] = [];
  const originalCacheDir = process.env.CHATGPT_DESKTOP_CACHE_DIR;

  afterEach(() => {
    if (originalCacheDir === undefined) {
      delete process.env.CHATGPT_DESKTOP_CACHE_DIR;
    } else {
      process.env.CHATGPT_DESKTOP_CACHE_DIR = originalCacheDir;
    }

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createCacheDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "chatgpt-cache-"));
    tempDirs.push(dir);
    process.env.CHATGPT_DESKTOP_CACHE_DIR = dir;
    return dir;
  }

  it("returns only images that were absent from the pre-send snapshot", async () => {
    const dir = createCacheDir();
    const oldImage = path.join(dir, "old-image");
    writePng(oldImage);

    const before = await snapshotCache();
    writePng(oldImage);

    const newImage = path.join(dir, "new-image");
    writePng(newImage);

    await expect(diffCache(before)).resolves.toMatchObject([
      {
        fileName: "new-image",
        mimeType: "image/png",
        fileSize: 60_008
      }
    ]);
  });

  it("detects new image files inside nested cache directories", async () => {
    const dir = createCacheDir();
    const before = await snapshotCache();

    mkdirSync(path.join(dir, "DiskStorage"));
    writePng(path.join(dir, "DiskStorage", "nested-image"));

    await expect(diffCache(before)).resolves.toMatchObject([
      {
        fileName: path.join("DiskStorage", "nested-image"),
        mimeType: "image/png"
      }
    ]);
  });
});
