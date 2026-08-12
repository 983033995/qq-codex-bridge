import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlApiServer } from "../../apps/control-daemon/src/index.js";
import { StructuredEventBus } from "../../packages/observability/src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("vNext static control UI", () => {
  it("serves the Vite entry, SPA fallback, immutable assets, and HEAD responses", async () => {
    const staticRoot = await createStaticRoot();
    const server = new ControlApiServer({
      host: "127.0.0.1",
      port: 0,
      services: { execute: async () => undefined },
      events: new StructuredEventBus(),
      staticRoot
    });
    await server.start();
    const address = server.address();
    if (!address) {
      throw new Error("static UI test server has no address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const entry = await fetch(`${baseUrl}/`);
      expect(entry.status).toBe(200);
      expect(entry.headers.get("content-type")).toContain("text/html");
      await expect(entry.text()).resolves.toContain("control-ui-entry");

      const spaRoute = await fetch(`${baseUrl}/settings`);
      expect(spaRoute.status).toBe(200);
      await expect(spaRoute.text()).resolves.toContain("control-ui-entry");

      const asset = await fetch(`${baseUrl}/assets/app-123.js`);
      expect(asset.headers.get("cache-control")).toContain("immutable");
      await expect(asset.text()).resolves.toBe("console.log('ui');\n");

      const head = await fetch(`${baseUrl}/assets/app-123.js`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength("console.log('ui');\n")));
      await expect(head.text()).resolves.toBe("");

      const missing = await fetch(`${baseUrl}/assets/missing.js`);
      expect(missing.status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});

async function createStaticRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qq-codex-control-ui-"));
  temporaryDirectories.push(directory);
  await mkdir(path.join(directory, "assets"));
  await writeFile(path.join(directory, "index.html"), "<!doctype html><p>control-ui-entry</p>\n");
  await writeFile(path.join(directory, "assets/app-123.js"), "console.log('ui');\n");
  return directory;
}
