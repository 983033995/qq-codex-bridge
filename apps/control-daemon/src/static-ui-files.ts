import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ServerResponse } from "node:http";

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

export class StaticUiFiles {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(required(root, "staticRoot"));
  }

  async serve(pathname: string, method: "GET" | "HEAD", response: ServerResponse): Promise<boolean> {
    const relativePath = safeRelativePath(pathname);
    if (relativePath === null) {
      return false;
    }
    const requestedFile = relativePath === "" || path.extname(relativePath) === ""
      ? "index.html"
      : relativePath;
    const filePath = path.resolve(this.root, requestedFile);
    if (filePath !== this.root && !filePath.startsWith(`${this.root}${path.sep}`)) {
      return false;
    }
    try {
      if (!(await stat(filePath)).isFile()) {
        return false;
      }
      const content = await readFile(filePath);
      response.statusCode = 200;
      response.setHeader("Content-Type", contentTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream");
      response.setHeader("Content-Length", content.byteLength);
      response.setHeader(
        "Cache-Control",
        relativePath.startsWith("assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache"
      );
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.end(method === "HEAD" ? undefined : content);
      return true;
    } catch (error) {
      if (isMissingFile(error)) {
        return false;
      }
      throw error;
    }
  }
}

function safeRelativePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) {
    return null;
  }
  return decoded.replace(/^\/+/, "");
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && ((error as NodeJS.ErrnoException).code === "ENOENT"
      || (error as NodeJS.ErrnoException).code === "ENOTDIR");
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}
