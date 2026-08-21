import { describe, expect, it, vi } from "vitest";
import { UnifiedDesktopDriver } from "../../packages/adapters/unified-desktop/src/unified-driver.js";
import { DesktopDriverError } from "../../packages/domain/src/driver.js";
import type { InboundMessage } from "../../packages/domain/src/message.js";
import type { DesktopDriverPort } from "../../packages/ports/src/conversation.js";

const message: InboundMessage = {
  messageId: "message-1",
  accountKey: "qqbot:default",
  sessionKey: "qqbot:default::qq:c2c:user-1",
  peerKey: "qq:c2c:user-1",
  chatType: "c2c",
  senderId: "user-1",
  text: "hello",
  receivedAt: "2026-08-03T10:00:00.000Z"
};

describe("unified desktop driver", () => {
  it("uses app-server for a healthy turn", async () => {
    const appServer = createDriver("codex-app-thread:primary");
    const cdp = createDriver("cdp-target:fallback");
    const driver = new UnifiedDesktopDriver({
      appServer,
      cdp,
      transport: "auto",
      probeIntervalMs: 0
    });

    const binding = await driver.openOrBindSession(message.sessionKey, null);
    await driver.sendUserMessage(binding, message);
    await driver.collectAssistantReply(binding);

    expect(appServer.sendUserMessage).toHaveBeenCalledOnce();
    expect(cdp.sendUserMessage).not.toHaveBeenCalled();
    expect(driver.getTransportStatus().active).toBe("app-server");
    driver.dispose();
  });

  it("falls back before a message is accepted", async () => {
    const appServer = createDriver("codex-app-thread:primary");
    appServer.sendUserMessage = vi.fn().mockRejectedValue(
      new DesktopDriverError("app-server unavailable", "app_not_ready")
    );
    const cdp = createDriver("cdp-target:fallback");
    const driver = new UnifiedDesktopDriver({
      appServer,
      cdp,
      transport: "auto",
      probeIntervalMs: 0
    });

    const binding = await driver.openOrBindSession(message.sessionKey, null);
    await driver.sendUserMessage(binding, message);
    await driver.collectAssistantReply(binding);

    expect(appServer.sendUserMessage).toHaveBeenCalledOnce();
    expect(cdp.openOrBindSession).toHaveBeenCalledOnce();
    expect(cdp.sendUserMessage).toHaveBeenCalledOnce();
    expect(cdp.collectAssistantReply).toHaveBeenCalledOnce();
    expect(binding.codexThreadRef).toBe("cdp-target:fallback");
    expect(driver.getTransportStatus().active).toBe("app-server");
    driver.dispose();
  });

  it("keeps the AppServer preference for other Sessions after one Session falls back", async () => {
    const appServer = createDriver("codex-app-thread:primary");
    appServer.sendUserMessage = vi.fn()
      .mockRejectedValueOnce(new DesktopDriverError("app-server unavailable", "app_not_ready"))
      .mockResolvedValueOnce(undefined);
    const cdp = createDriver("cdp-target:fallback");
    const driver = new UnifiedDesktopDriver({
      appServer,
      cdp,
      transport: "auto",
      probeIntervalMs: 0
    });

    const firstBinding = await driver.openOrBindSession(message.sessionKey, null);
    await driver.sendUserMessage(firstBinding, message);
    await driver.collectAssistantReply(firstBinding);

    const secondMessage = { ...message, messageId: "message-2", sessionKey: "session-2" };
    const secondBinding = await driver.openOrBindSession(secondMessage.sessionKey, null);
    await driver.sendUserMessage(secondBinding, secondMessage);

    expect(appServer.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(cdp.sendUserMessage).toHaveBeenCalledOnce();
    expect(driver.getTransportStatus().active).toBe("app-server");
    driver.dispose();
  });

  it("never resends after the primary accepted the message", async () => {
    const appServer = createDriver("codex-app-thread:primary");
    appServer.collectAssistantReply = vi.fn().mockRejectedValue(new Error("reply interrupted"));
    const cdp = createDriver("cdp-target:fallback");
    const driver = new UnifiedDesktopDriver({
      appServer,
      cdp,
      transport: "auto",
      probeIntervalMs: 0
    });

    const binding = await driver.openOrBindSession(message.sessionKey, null);
    await driver.sendUserMessage(binding, message);
    await expect(driver.collectAssistantReply(binding)).rejects.toThrow("reply interrupted");

    expect(appServer.sendUserMessage).toHaveBeenCalledOnce();
    expect(cdp.sendUserMessage).not.toHaveBeenCalled();
    driver.dispose();
  });

  it("does not resend when submission acknowledgement is ambiguous", async () => {
    const appServer = createDriver("codex-app-thread:primary");
    appServer.sendUserMessage = vi.fn().mockRejectedValue(
      new Error("Codex app-server request timed out: turn/start")
    );
    const cdp = createDriver("cdp-target:fallback");
    const driver = new UnifiedDesktopDriver({
      appServer,
      cdp,
      transport: "auto",
      probeIntervalMs: 0
    });

    const binding = await driver.openOrBindSession(message.sessionKey, null);
    await expect(driver.sendUserMessage(binding, message)).rejects.toThrow("turn/start");

    expect(cdp.sendUserMessage).not.toHaveBeenCalled();
    driver.dispose();
  });

  it("disposes both underlying drivers so no spawned process is orphaned on shutdown", async () => {
    const appServer = createDriver("codex-app-thread:primary");
    const cdp = createDriver("cdp-target:fallback");
    const driver = new UnifiedDesktopDriver({
      appServer,
      cdp,
      transport: "auto",
      probeIntervalMs: 0
    });

    driver.dispose();

    expect(appServer.dispose).toHaveBeenCalledOnce();
    expect(cdp.dispose).toHaveBeenCalledOnce();
  });
});

function createDriver(threadRef: string): DesktopDriverPort {
  return {
    ensureAppReady: vi.fn().mockResolvedValue(undefined),
    getControlState: vi.fn().mockResolvedValue({
      model: null,
      reasoningEffort: null,
      workspace: null,
      branch: null,
      permissionMode: null,
      quotaSummary: null
    }),
    getQuotaSummary: vi.fn().mockResolvedValue(null),
    switchModel: vi.fn(),
    openOrBindSession: vi.fn().mockImplementation(async (sessionKey: string) => ({
      sessionKey,
      codexThreadRef: threadRef
    })),
    listRecentThreads: vi.fn().mockResolvedValue([]),
    switchToThread: vi.fn(),
    createThread: vi.fn(),
    sendUserMessage: vi.fn().mockResolvedValue(undefined),
    collectAssistantReply: vi.fn().mockResolvedValue([]),
    markSessionBroken: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn()
  };
}
