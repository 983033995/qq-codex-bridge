import fs from "node:fs";
import path from "node:path";
import { PushRequestError } from "./push-error.js";

export class PushMediaGuard {
  private readonly root: string;

  constructor(outboxRoot: string) {
    fs.mkdirSync(outboxRoot, { recursive: true });
    this.root = fs.realpathSync.native(outboxRoot);
  }

  resolve(mediaPath: string): string {
    if (/^(?:file|https?):\/\//i.test(mediaPath)) {
      throw violation("media URLs are not allowed");
    }
    const candidate = path.isAbsolute(mediaPath)
      ? mediaPath
      : path.resolve(this.root, mediaPath);
    let realPath: string;
    try {
      realPath = fs.realpathSync.native(candidate);
    } catch {
      throw violation("media file does not exist");
    }
    if (realPath !== this.root && !realPath.startsWith(`${this.root}${path.sep}`)) {
      throw violation("media path escapes push outbox");
    }
    if (!fs.statSync(realPath).isFile()) {
      throw violation("media path must reference a file");
    }
    return realPath;
  }
}

function violation(message: string): PushRequestError {
  return new PushRequestError(400, "media_sandbox_violation", message);
}
