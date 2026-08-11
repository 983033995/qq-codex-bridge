import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WeixinMessageStateStore } from "../../packages/channel-weixin/src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("vNext Weixin message state store", () => {
  it("persists cursors and context tokens atomically with owner-only permissions", async () => {
    const directory = await createTemporaryDirectory();
    const filePath = path.join(directory, "state", "weixin-message.json");
    const store = new WeixinMessageStateStore(filePath);
    await store.load();

    await Promise.all([
      store.setCursor("weixin:personal", "cursor-2"),
      store.setContextToken("weixin:personal", "peer-1", "context-1"),
      store.setCursor("weixin:work", "cursor-work"),
      store.setContextToken("weixin:work", "peer-2", "context-2")
    ]);

    const restored = new WeixinMessageStateStore(filePath);
    await restored.load();
    expect(restored.getCursor("weixin:personal")).toBe("cursor-2");
    expect(restored.getContextToken("weixin:personal", "peer-1")).toBe("context-1");
    expect(restored.getCursor("weixin:work")).toBe("cursor-work");
    expect(restored.getContextToken("weixin:work", "peer-2")).toBe("context-2");
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect(await readdir(path.dirname(filePath))).toEqual(["weixin-message.json"]);
  });

  it("fails loudly for invalid persisted state", async () => {
    const directory = await createTemporaryDirectory();
    const filePath = path.join(directory, "weixin-message.json");
    await writeFile(filePath, JSON.stringify({ version: 1, accounts: { account: { token: "unexpected" } } }));

    const store = new WeixinMessageStateStore(filePath);
    await expect(store.load()).rejects.toThrow("Weixin message state file is invalid");
    expect(await readFile(filePath, "utf8")).toContain("unexpected");
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "qqcb-vnext-weixin-message-"));
  temporaryDirectories.push(directory);
  return directory;
}
