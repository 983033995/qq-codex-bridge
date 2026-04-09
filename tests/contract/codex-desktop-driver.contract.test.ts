import { describe, expect, it, vi } from "vitest";
import { DesktopDriverError } from "../../packages/domain/src/driver.js";
import { CodexDesktopDriver } from "../../packages/adapters/codex-desktop/src/codex-desktop-driver.js";
import { parseAssistantReply } from "../../packages/adapters/codex-desktop/src/reply-parser.js";
import type { CdpSession } from "../../packages/adapters/codex-desktop/src/cdp-session.js";

describe("codex desktop driver contract", () => {
  it("extracts the latest assistant reply from a snapshot string", () => {
    const reply = parseAssistantReply(`
      User: hello
      Assistant: first reply
      Assistant: latest reply
    `);

    expect(reply).toBe("latest reply");
  });

  it("fails readiness when no inspectable page target exists", async () => {
    const driver = new CodexDesktopDriver({
      connect: vi.fn().mockResolvedValue({
        appName: "Codex",
        browserVersion: "Codex/1.0",
        browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
      }),
      listTargets: vi.fn().mockResolvedValue([])
    } as unknown as CdpSession);

    await expect(driver.ensureAppReady()).rejects.toEqual(
      new DesktopDriverError("Codex desktop app is not exposing any inspectable page target", "app_not_ready")
    );
  });
});
