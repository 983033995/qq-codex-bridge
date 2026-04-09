import { describe, expect, it, vi } from "vitest";
import {
  ensureCodexDesktopForDev,
  launchCodexDesktop,
  resolveDarwinAppExecutablePath
} from "../../apps/bridge-daemon/src/dev-launch.js";

describe("dev launch", () => {
  it("skips launching when the cdp endpoint is already reachable", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          Browser: "Codex/1.0",
          webSocketDebuggerUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );
    const launchApp = vi.fn();

    await expect(
      ensureCodexDesktopForDev(
        {
          appName: "Codex",
          remoteDebuggingPort: 9229,
          startupTimeoutMs: 100,
          startupPollIntervalMs: 0
        },
        {
          fetchFn,
          launchApp,
          sleep: async () => undefined
        }
      )
    ).resolves.toEqual({
      launched: false
    });
    expect(launchApp).not.toHaveBeenCalled();
  });

  it("launches the app and waits until the cdp endpoint becomes reachable", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("connect refused"))
      .mockRejectedValueOnce(new Error("still starting"))
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            Browser: "Codex/1.0",
            webSocketDebuggerUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        )
      );
    const launchApp = vi.fn().mockResolvedValue(undefined);

    await expect(
      ensureCodexDesktopForDev(
        {
          appName: "Codex",
          remoteDebuggingPort: 9229,
          startupTimeoutMs: 100,
          startupPollIntervalMs: 0
        },
        {
          fetchFn,
          launchApp,
          sleep: async () => undefined
        }
      )
    ).resolves.toEqual({
      launched: true
    });
    expect(launchApp).toHaveBeenCalledWith("Codex", 9229);
  });

  it("fails after the startup timeout when the cdp endpoint never appears", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("connect refused"));
    const launchApp = vi.fn().mockResolvedValue(undefined);

    await expect(
      ensureCodexDesktopForDev(
        {
          appName: "Codex",
          remoteDebuggingPort: 9229,
          startupTimeoutMs: 1,
          startupPollIntervalMs: 0
        },
        {
          fetchFn,
          launchApp,
          sleep: async () => undefined
        }
      )
    ).rejects.toThrow("Timed out waiting for Codex desktop CDP endpoint on port 9229");
  });

  it("launches Codex on macOS via the app executable with a remote debugging port", () => {
    const unref = vi.fn();
    const spawnFn = vi.fn().mockReturnValue({
      unref
    });

    launchCodexDesktop("Codex", 9229, {
      platform: "darwin",
      spawnFn,
      appExecutablePath: "/Applications/Codex.app/Contents/MacOS/Codex"
    });

    expect(spawnFn).toHaveBeenCalledWith(
      "/Applications/Codex.app/Contents/MacOS/Codex",
      ["--remote-debugging-port=9229"],
      {
        detached: true,
        stdio: "ignore"
      }
    );
    expect(unref).toHaveBeenCalled();
  });

  it("falls back to Codex.app when the configured app name does not match the installed bundle", () => {
    const executablePath = resolveDarwinAppExecutablePath("Anthropic Codex", {
      searchRoots: ["/Applications"],
      existsSyncFn: (candidate) =>
        candidate === "/Applications/Codex.app/Contents/MacOS/Codex"
    });

    expect(executablePath).toBe("/Applications/Codex.app/Contents/MacOS/Codex");
  });
});
