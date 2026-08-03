import { describe, expect, it, vi } from "vitest";
import { DesktopFeatureProbe } from "../../packages/adapters/unified-desktop/src/feature-probe.js";

describe("desktop feature probe", () => {
  it("prefers app-server in auto mode", async () => {
    const appServer = { ensureAppReady: vi.fn().mockResolvedValue(undefined) };
    const cdp = { ensureAppReady: vi.fn().mockResolvedValue(undefined) };
    const probe = new DesktopFeatureProbe({
      appServer,
      cdp,
      configured: "auto",
      now: () => new Date("2026-08-03T10:00:00.000Z")
    });

    await expect(probe.probe()).resolves.toBe("app-server");
    expect(cdp.ensureAppReady).not.toHaveBeenCalled();
    expect(probe.getStatus()).toEqual(
      expect.objectContaining({
        active: "app-server",
        appServerAvailable: true,
        lastProbedAt: "2026-08-03T10:00:00.000Z"
      })
    );
  });

  it("falls back to cdp when app-server is unavailable", async () => {
    const probe = new DesktopFeatureProbe({
      appServer: {
        ensureAppReady: vi.fn().mockRejectedValue(new Error("app-server unavailable"))
      },
      cdp: { ensureAppReady: vi.fn().mockResolvedValue(undefined) },
      configured: "auto"
    });

    await expect(probe.probe()).resolves.toBe("cdp");
    expect(probe.getStatus()).toEqual(
      expect.objectContaining({
        active: "cdp",
        appServerAvailable: false,
        cdpAvailable: true,
        lastError: "app-server unavailable"
      })
    );
  });

  it("does not silently fall back in forced app-server mode", async () => {
    const cdp = { ensureAppReady: vi.fn().mockResolvedValue(undefined) };
    const probe = new DesktopFeatureProbe({
      appServer: {
        ensureAppReady: vi.fn().mockRejectedValue(new Error("forced transport failed"))
      },
      cdp,
      configured: "app-server"
    });

    await expect(probe.probe()).rejects.toThrow("forced transport failed");
    expect(cdp.ensureAppReady).not.toHaveBeenCalled();
  });
});
