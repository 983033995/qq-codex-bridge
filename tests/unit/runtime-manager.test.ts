import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import type { SpawnOptions } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RuntimeManager,
  migrateLegacyGatewayData,
  resolveGatewayPaths
} from "../../packages/runtime-manager/src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("OmniAgent Gateway RuntimeManager", () => {
  it("serializes ten concurrent ensureRunning calls into one detached Runtime", async () => {
    const root = await temporaryRoot();
    const alive = new Set<number>();
    let ready = false;
    const spawnRuntime = vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => {
      alive.add(4242);
      ready = true;
      return { pid: 4242, unref: vi.fn() };
    });
    const managers = Array.from({ length: 10 }, () => new RuntimeManager({
      root,
      legacyRoot: path.join(root, "legacy"),
      runtimeEntrypoint: "/tmp/control-daemon.js",
      spawnRuntime,
      isProcessAlive: (pid) => alive.has(pid),
      probeReady: async () => ready,
      pollIntervalMs: 1,
      startupTimeoutMs: 1_000,
      lockTimeoutMs: 2_000
    }));

    const statuses = await Promise.all(managers.map((manager) => manager.ensureRunning()));

    expect(spawnRuntime).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "ready", pid: 4242, baseUrl: "http://127.0.0.1:3100" })
    ]));
    const spawnOptions = spawnRuntime.mock.calls[0]![2];
    expect(spawnOptions).toMatchObject({ detached: true });
    expect(spawnOptions.env).toMatchObject({ OMNIAGENT_GATEWAY_HOME: root });
    await expect(readFile(managers[0]!.paths.pidPath, "utf8")).resolves.toBe("4242\n");
    await expect(stat(managers[0]!.paths.runtimeStatePath)).resolves.toMatchObject({ mode: expect.any(Number) });
  });

  it("removes stale state before starting and removes a stale malformed lock", async () => {
    const root = await temporaryRoot();
    const paths = resolveGatewayPaths({ root, legacyRoot: path.join(root, "legacy") });
    await rm(paths.runtimeDirectory, { recursive: true, force: true });
    await import("node:fs/promises").then(({ mkdir }) => mkdir(paths.runtimeDirectory, { recursive: true }));
    await writeFile(paths.runtimeStatePath, JSON.stringify({
      version: 1,
      pid: 9999,
      baseUrl: "http://127.0.0.1:3100",
      startedAt: "2026-08-13T00:00:00.000Z"
    }));
    await writeFile(paths.runtimeLockPath, "not-json");
    const old = new Date(Date.now() - 60_000);
    await utimes(paths.runtimeLockPath, old, old);
    let ready = false;
    const spawnRuntime = vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => {
      ready = true;
      return { pid: 5000, unref: vi.fn() };
    });
    const manager = new RuntimeManager({
      root,
      legacyRoot: path.join(root, "legacy"),
      runtimeEntrypoint: "/tmp/control-daemon.js",
      spawnRuntime,
      isProcessAlive: (pid) => pid === 5000,
      probeReady: async () => ready,
      pollIntervalMs: 1,
      startupTimeoutMs: 100,
      lockTimeoutMs: 100,
      staleLockMs: 1
    });

    await expect(manager.ensureRunning()).resolves.toMatchObject({ state: "ready", pid: 5000 });
    expect(spawnRuntime).toHaveBeenCalledTimes(1);
    await expect(readFile(paths.runtimeLockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("copies legacy state once without deleting or overwriting rollback data", async () => {
    const root = await temporaryRoot();
    const legacyRoot = path.join(root, "legacy");
    const nextRoot = path.join(root, "next");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(legacyRoot, { recursive: true }));
    await writeFile(path.join(legacyRoot, "config.json"), "legacy-config");
    await writeFile(path.join(legacyRoot, "runtime-vnext.db"), "legacy-database");
    await writeFile(path.join(legacyRoot, "weixin-login-state.json"), "legacy-login");
    const paths = resolveGatewayPaths({ root: nextRoot, legacyRoot });

    const first = await migrateLegacyGatewayData(paths);
    expect(first.migrated.sort()).toEqual([
      "config.json",
      "runtime-vnext.db",
      "weixin-login-state.json"
    ]);
    await writeFile(paths.configPath, "new-config");
    const second = await migrateLegacyGatewayData(paths);

    expect(second.migrated).toEqual([]);
    expect(second.skipped).toEqual(expect.arrayContaining([
      "config.json",
      "runtime-vnext.db",
      "weixin-login-state.json"
    ]));
    await expect(readFile(paths.configPath, "utf8")).resolves.toBe("new-config");
    await expect(readFile(path.join(legacyRoot, "config.json"), "utf8")).resolves.toBe("legacy-config");
    await expect(readFile(paths.databasePath, "utf8")).resolves.toBe("legacy-database");
  });
});

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omniagent-runtime-manager-"));
  temporaryDirectories.push(directory);
  return directory;
}
