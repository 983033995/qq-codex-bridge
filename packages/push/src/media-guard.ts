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
      throw this.violation(
        "media URLs are not allowed; copy the file into the push outbox and reference it by local path instead"
      );
    }
    const candidate = path.isAbsolute(mediaPath)
      ? mediaPath
      : path.resolve(this.root, mediaPath);
    let realPath: string;
    try {
      realPath = fs.realpathSync.native(candidate);
    } catch {
      throw this.violation(
        `media file does not exist: "${mediaPath}" was not found inside the push outbox. ` +
          `Copy or move the file into the outbox directory first, then reference it with a path ` +
          `relative to the outbox root (or the resulting absolute path).`
      );
    }
    if (realPath !== this.root && !realPath.startsWith(`${this.root}${path.sep}`)) {
      throw this.violation(
        `media path escapes push outbox: "${mediaPath}" resolves outside the outbox root. ` +
          `Copy the file into the outbox root before pushing it.`
      );
    }
    if (!fs.statSync(realPath).isFile()) {
      throw this.violation("media path must reference a file, not a directory");
    }
    return realPath;
  }

  private violation(message: string): PushRequestError {
    return new PushRequestError(400, "media_sandbox_violation", `${message} (push outbox root: ${this.root})`);
  }
}
