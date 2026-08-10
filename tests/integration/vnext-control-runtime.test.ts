import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProductionControlDaemon } from "../../apps/control-daemon/src/index.js";
import {
  AtomicConfigStore,
  calculateConfigRevision,
  createDefaultConfig
} from "../../packages/config/src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("vNext production control runtime", () => {
  it("serves the UI and real system state through the composed API", async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "qqcb-vnext-runtime-"));
    temporaryDirectories.push(dataDirectory);
    const staticRoot = path.join(dataDirectory, "ui");
    await mkdir(staticRoot);
    await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><p>vnext-control-ui</p>\n");
    const config = createDefaultConfig();
    config.runtime.listenPort = await freePort();
    await new AtomicConfigStore(path.join(dataDirectory, "config.json")).writeAtomic({
      value: config,
      revision: calculateConfigRevision(config)
    });
    const runtime = await createProductionControlDaemon({ dataDirectory, staticRoot });
    try {
      await runtime.start();
      const entry = await fetch(`${runtime.baseUrl}/`);
      expect(entry.status).toBe(200);
      await expect(entry.text()).resolves.toContain("vnext-control-ui");

      const sessionResponse = await fetch(`${runtime.baseUrl}/api/v1/session`);
      const cookie = sessionResponse.headers.get("set-cookie")!.split(";", 1)[0]!;
      const statusResponse = await fetch(`${runtime.baseUrl}/api/v1/system/status`, {
        headers: { Cookie: cookie }
      });
      expect(statusResponse.status).toBe(200);
      await expect(statusResponse.json()).resolves.toMatchObject({
        data: {
          state: "running",
          activeRevision: calculateConfigRevision(config),
          version: "0.2.0"
        }
      });

      const healthResponse = await fetch(`${runtime.baseUrl}/api/v1/health`, {
        headers: { Cookie: cookie }
      });
      expect(healthResponse.status).toBe(200);
      const health = await healthResponse.json() as {
        data: { components: Array<{ component: string; code?: string }> };
      };
      expect(health.data.components).toEqual(expect.arrayContaining([
        expect.objectContaining({ component: "codex" }),
        expect.objectContaining({ component: "management-api" })
      ]));
      expect(health.data.components).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "HEALTH_CHECK_FAILED" })
      ]));

      const eventsResponse = await fetch(`${runtime.baseUrl}/api/v1/diagnostics/events?limit=20`, {
        headers: { Cookie: cookie }
      });
      expect(eventsResponse.status).toBe(200);
      await expect(eventsResponse.json()).resolves.toMatchObject({
        data: { items: expect.arrayContaining([expect.objectContaining({ type: "component.started" })]) }
      });
    } finally {
      await runtime.stop();
    }
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a loopback test port");
  }
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
