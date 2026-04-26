import { createReadStream, readdirSync } from "node:fs";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";

const DEFAULT_CACHE_DIR = join(
  homedir(),
  "Library/Caches/com.openai.chat",
  "com.onevcat.Kingfisher.ImageCache",
  "com.onevcat.Kingfisher.ImageCache.com.openai.chat"
);

const MIN_IMAGE_BYTES = 50_000;

export type CacheSnapshot = { files: Set<string>; timestamp: number };

function cacheDir(): string {
  return process.env.CHATGPT_DESKTOP_CACHE_DIR ?? DEFAULT_CACHE_DIR;
}

async function listCacheFiles(dir = cacheDir()): Promise<Array<{ name: string; path: string }>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: Array<{ name: string; path: string }> = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listCacheFiles(fullPath);
      files.push(...nested.map((file) => ({
        name: relative(dir, file.path),
        path: file.path
      })));
      continue;
    }
    if (entry.isFile()) {
      files.push({
        name: relative(dir, fullPath),
        path: fullPath
      });
    }
  }

  return files;
}

export async function snapshotCache(): Promise<CacheSnapshot> {
  const timestamp = Date.now();
  try {
    const files = await listCacheFiles();
    return { files: new Set(files.map((file) => file.name)), timestamp };
  } catch {
    return { files: new Set(), timestamp };
  }
}

async function readMagicBytes(filePath: string, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const buf: Buffer[] = [];
    let collected = 0;
    const stream = createReadStream(filePath, { start: 0, end: n - 1 });
    stream.on("data", (chunk) => {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buf.push(b);
      collected += b.length;
    });
    stream.on("end", () => resolve(Buffer.concat(buf, collected)));
    stream.on("error", reject);
  });
}

function detectMime(magic: Buffer): string | null {
  if (magic.length < 4) return null;
  if (magic[0] === 0x89 && magic[1] === 0x50 && magic[2] === 0x4e && magic[3] === 0x47) return "image/png";
  if (magic[0] === 0xff && magic[1] === 0xd8 && magic[2] === 0xff) return "image/jpeg";
  if (
    magic[0] === 0x52 && magic[1] === 0x49 && magic[2] === 0x46 && magic[3] === 0x46 &&
    magic.length >= 12 &&
    magic[8] === 0x57 && magic[9] === 0x45 && magic[10] === 0x42 && magic[11] === 0x50
  ) return "image/webp";
  if (magic[0] === 0x47 && magic[1] === 0x49 && magic[2] === 0x46) return "image/gif";
  return null;
}

export type CachedImage = {
  sourcePath: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  createdAtMs: number;
};

export async function diffCache(before: CacheSnapshot): Promise<CachedImage[]> {
  let current: Array<{ name: string; path: string }>;
  try {
    current = await listCacheFiles();
  } catch {
    return [];
  }

  const images: CachedImage[] = [];

  for (const { name, path: fullPath } of current) {
    if (before.files.has(name)) {
      continue;
    }

    try {
      const info = await stat(fullPath);
      if (!info.isFile() || info.size < MIN_IMAGE_BYTES) continue;

      const magic = await readMagicBytes(fullPath, 16);
      const mimeType = detectMime(magic);
      if (!mimeType) continue;

      images.push({
        sourcePath: fullPath,
        fileName: name,
        mimeType,
        fileSize: info.size,
        createdAtMs: Math.max(info.birthtimeMs, info.ctimeMs)
      });
    } catch {
      // skip unreadable files
    }
  }

  return images.sort((a, b) => a.createdAtMs - b.createdAtMs);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function waitForCacheImages(
  before: CacheSnapshot,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<CachedImage[]> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const images = await diffCache(before);
    if (images.length > 0 || Date.now() >= deadline) {
      return images;
    }
    await delay(intervalMs);
  }
}

export type SavedImage = {
  localPath: string;
  originalName: string;
  mimeType: string;
  fileSize: number;
};

const EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif"
};

export async function saveToDest(
  images: CachedImage[],
  destDir: string,
  prefix: string
): Promise<SavedImage[]> {
  await mkdir(destDir, { recursive: true });
  const saved: SavedImage[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const ext = EXT[img.mimeType] ?? ".bin";
    const name = `${prefix}-${String(i + 1).padStart(3, "0")}${ext}`;
    const dest = join(destDir, name);
    await copyFile(img.sourcePath, dest);
    saved.push({
      localPath: dest,
      originalName: name,
      mimeType: img.mimeType,
      fileSize: img.fileSize
    });
  }
  return saved;
}

export function isCacheDirReachable(): boolean {
  try {
    readdirSync(cacheDir());
    return true;
  } catch {
    return false;
  }
}
