import { describe, expect, it, vi } from "vitest";
import { runGatewayCli } from "../../apps/omniagent-gateway/src/cli.js";
import type { RuntimeStatus } from "../../packages/runtime-manager/src/index.js";

describe("OmniAgent Gateway CLI", () => {
  it("exposes lifecycle commands and sends MCP through the same RuntimeManager", async () => {
    const ready = status("ready");
    const runtime = {
      ensureRunning: vi.fn(async () => ready),
      stop: vi.fn(async () => undefined),
      restart: vi.fn(async () => ready),
      getStatus: vi.fn(async () => ready),
      doctor: vi.fn(async () => [{ code: "RUNTIME_READY", status: "ok" as const, message: "ready" }])
    };
    const output: string[] = [];
    const runMcp = vi.fn(async () => undefined);

    expect(await runGatewayCli(["start"], { runtime, writeStdout: output.push.bind(output) })).toBe(0);
    expect(await runGatewayCli(["status"], { runtime, writeStdout: output.push.bind(output) })).toBe(0);
    expect(await runGatewayCli(["doctor"], { runtime, writeStdout: output.push.bind(output) })).toBe(0);
    expect(await runGatewayCli(["mcp"], { runtime, runMcp })).toBe(0);

    expect(runtime.ensureRunning).toHaveBeenCalledTimes(1);
    expect(runtime.getStatus).toHaveBeenCalledTimes(1);
    expect(runtime.doctor).toHaveBeenCalledTimes(1);
    expect(runMcp).toHaveBeenCalledWith(runtime);
    expect(output.join("\n")).toContain("OmniAgent Gateway");
  });

  it("opens only the local URL returned by a ready Runtime", async () => {
    const openUrl = vi.fn(async () => undefined);
    const runtime = {
      ensureRunning: vi.fn(async () => status("ready")),
      stop: vi.fn(async () => undefined),
      restart: vi.fn(async () => status("ready")),
      getStatus: vi.fn(async () => status("ready")),
      doctor: vi.fn(async () => [])
    };
    const output: string[] = [];

    expect(await runGatewayCli(["open"], {
      runtime,
      openUrl,
      writeStdout: output.push.bind(output)
    })).toBe(0);
    expect(openUrl).toHaveBeenCalledWith("http://127.0.0.1:3100");
  });

  it("keeps compatibility guidance and fails loudly for unknown commands", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const runtime = {
      ensureRunning: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
      getStatus: vi.fn(),
      doctor: vi.fn()
    };

    expect(await runGatewayCli(["help"], {
      runtime,
      writeStdout: stdout.push.bind(stdout),
      writeStderr: stderr.push.bind(stderr)
    })).toBe(0);
    expect(stdout.join("\n")).toContain("qq-codex-bridge");
    expect(stdout.join("\n")).toContain("qq-codex-mcp");
    expect(await runGatewayCli(["missing"], {
      runtime,
      writeStdout: stdout.push.bind(stdout),
      writeStderr: stderr.push.bind(stderr)
    })).toBe(1);
    expect(stderr.join("\n")).toContain("未知命令");
  });
});

function status(state: RuntimeStatus["state"]): RuntimeStatus {
  return {
    state,
    pid: 4242,
    baseUrl: "http://127.0.0.1:3100",
    startedAt: "2026-08-13T00:00:00.000Z",
    checkedAt: "2026-08-13T00:00:01.000Z",
    reused: false,
    message: "OmniAgent Gateway Runtime is ready"
  };
}
