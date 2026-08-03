import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PushMediaGuard } from "../../packages/push/src/media-guard.js";

describe("push media guard", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

  it("accepts real files in the outbox and rejects URL or symlink escapes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-media-"));
    roots.push(root);
    const outbox = path.join(root, "outbox");
    const outside = path.join(root, "secret.txt");
    fs.mkdirSync(outbox);
    fs.writeFileSync(outside, "secret");
    fs.writeFileSync(path.join(outbox, "report.png"), "image");
    fs.symlinkSync(outside, path.join(outbox, "escape.png"));
    const guard = new PushMediaGuard(outbox);

    expect(guard.resolve("report.png")).toBe(fs.realpathSync(path.join(outbox, "report.png")));
    expect(() => guard.resolve("escape.png")).toThrow(/escapes push outbox/);
    expect(() => guard.resolve("file:///etc/passwd")).toThrow(/URLs are not allowed/);
    expect(() => guard.resolve("https://example.com/report.png")).toThrow(/URLs are not allowed/);
  });
});
