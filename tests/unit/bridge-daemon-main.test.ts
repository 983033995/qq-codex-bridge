import { describe, expect, it, vi, afterEach } from "vitest";
import type { InboundMessage, TurnEvent } from "../../packages/domain/src/message.js";
import { createIngressMessageHandler, resolveTurnEventOrchestrator } from "../../apps/bridge-daemon/src/main.js";

function createMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: "msg-main-1",
    accountKey: "qqbot:default",
    sessionKey: "qqbot:default::qq:c2c:abc-123",
    peerKey: "qq:c2c:abc-123",
    chatType: "c2c",
    senderId: "abc-123",
    text: "hello",
    receivedAt: "2026-04-09T12:00:00.000Z",
    ...overrides
  };
}

describe("bridge daemon main", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes normal inbound messages to the orchestrator", async () => {
    const threadCommandHandler = {
      handleIfCommand: vi.fn().mockResolvedValue(false)
    };
    const orchestrator = {
      handleInbound: vi.fn().mockResolvedValue(undefined)
    };

    const handler = createIngressMessageHandler({
      threadCommandHandler: threadCommandHandler as any,
      orchestrator
    });

    const message = createMessage();
    await handler(message);

    expect(threadCommandHandler.handleIfCommand).toHaveBeenCalledWith(message);
    expect(orchestrator.handleInbound).toHaveBeenCalledWith(message);
  });

  it("logs inbound turn failures without rethrowing them", async () => {
    const threadCommandHandler = {
      handleIfCommand: vi.fn().mockResolvedValue(false)
    };
    const orchestrator = {
      handleInbound: vi.fn().mockRejectedValue(new Error("Codex desktop reply did not arrive before timeout"))
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const handler = createIngressMessageHandler({
      threadCommandHandler: threadCommandHandler as any,
      orchestrator
    });

    await expect(handler(createMessage())).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      "[qq-codex-bridge] message handling failed",
      expect.objectContaining({
        messageId: "msg-main-1",
        sessionKey: "qqbot:default::qq:c2c:abc-123",
        error: "Codex desktop reply did not arrive before timeout"
      })
    );
  });

  it("routes turn events to the matching channel orchestrator based on session key", () => {
    const qq = { handleTurnEvent: vi.fn() };
    const weixin = { handleTurnEvent: vi.fn() };
    const event: TurnEvent = {
      sessionKey: "weixin:default::wx:c2c:wxid-1",
      turnId: "turn-1",
      sequence: 2,
      eventType: "turn.completed" as TurnEvent["eventType"],
      createdAt: "2026-04-15T03:30:00.000Z",
      isFinal: true,
      payload: {
        fullText: "<qqmedia>/tmp/demo.jpg</qqmedia>"
      }
    };

    const resolved = resolveTurnEventOrchestrator(event, {
      qq,
      weixin
    });

    expect(resolved).toBe(weixin);
  });
});
