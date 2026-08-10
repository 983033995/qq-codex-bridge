import { describe, expect, it } from "vitest";
import {
  IdentifierError,
  StateTransitionError,
  VNextDomainError,
  assertBindingCanActivate,
  createChannelAccountId,
  createConversationSpaceId,
  getErrorDisposition,
  parseChannelAccountId,
  parseConversationSpaceId,
  stableErrorCodes,
  transitionDelivery,
  transitionTurn,
  type Delivery,
  type ThreadBinding,
  type Turn
} from "../../packages/domain/src/vnext/index.js";

const now = "2026-08-10T06:00:00.000Z";
const later = "2026-08-10T06:01:00.000Z";
const accountId = createChannelAccountId("weixin", "personal");
const spaceId = createConversationSpaceId(accountId, "c2c", "wxid_123");

describe("vNext identifiers", () => {
  it("creates and parses canonical channel and conversation-space ids", () => {
    expect(accountId).toBe("weixin:personal");
    expect(parseChannelAccountId(accountId)).toEqual({
      channel: "weixin",
      accountId: "personal"
    });
    expect(spaceId).toBe("weixin:personal::c2c:wxid_123");
    expect(parseConversationSpaceId(spaceId)).toEqual({
      channel: "weixin",
      accountId: "personal",
      channelAccountId: accountId,
      scope: "c2c",
      providerConversationId: "wxid_123"
    });
  });

  it.each([
    ["unknown:a", "channelAccountId"],
    ["weixin:", "channelAccountId"],
    [" weixin:a", "channelAccountId"],
    ["weixin:a::room:peer", "spaceId"],
    ["weixin:a::c2c:", "spaceId"]
  ])("rejects malformed identifier %s", (value, field) => {
    expect(() => {
      if (field === "spaceId") {
        parseConversationSpaceId(value);
      } else {
        parseChannelAccountId(value);
      }
    }).toThrow(IdentifierError);
  });
});

describe("vNext thread bindings", () => {
  it("rejects a second active binding for the same space", () => {
    const existing = binding("binding-a", spaceId, "thread-a", "exclusive");
    const candidate = binding("binding-b", spaceId, "thread-b", "exclusive");

    expect(() => assertBindingCanActivate(candidate, [existing])).toThrowError(
      expect.objectContaining({ code: "BINDING_CONFLICT" })
    );
  });

  it("rejects sharing when either active binding is exclusive", () => {
    const otherSpace = createConversationSpaceId(accountId, "c2c", "wxid_456");
    const existing = binding("binding-a", spaceId, "thread-a", "exclusive");
    const candidate = binding("binding-b", otherSpace, "thread-a", "shared");

    expect(() => assertBindingCanActivate(candidate, [existing])).toThrow(VNextDomainError);
  });

  it("allows multiple explicit shared bindings and ignores detached bindings", () => {
    const otherSpace = createConversationSpaceId(accountId, "group", "room_1");
    const existing = binding("binding-a", spaceId, "thread-a", "shared");
    const candidate = binding("binding-b", otherSpace, "thread-a", "shared");
    const detached = { ...binding("binding-c", otherSpace, "thread-b", "exclusive"), status: "detached" as const };

    expect(() => assertBindingCanActivate(candidate, [existing, detached])).not.toThrow();
  });
});

describe("vNext turn state machine", () => {
  it("moves through queued, starting, running, and completed deterministically", () => {
    const starting = transitionTurn(turn("queued"), "starting", { at: now });
    const running = transitionTurn(starting, "running", { at: later });
    const completed = transitionTurn(running, "completed", { at: later });

    expect(starting.startedAt).toBe(now);
    expect(running.startedAt).toBe(now);
    expect(completed).toMatchObject({
      status: "completed",
      startedAt: now,
      completedAt: later,
      errorCode: null
    });
  });

  it("rejects terminal transitions and failures without stable error codes", () => {
    expect(() => transitionTurn(turn("completed"), "running", { at: now })).toThrow(
      StateTransitionError
    );
    expect(() => transitionTurn(turn("running"), "failed", { at: now })).toThrowError(
      /stable error code/
    );
  });
});

describe("vNext delivery state machine", () => {
  it("counts send attempts and requires provider confirmation before delivery", () => {
    const sending = transitionDelivery(delivery("pending"), "sending", { at: now });
    expect(sending.attempts).toBe(1);
    expect(() => transitionDelivery(sending, "delivered", { at: later })).toThrowError(
      /provider message id/
    );

    expect(
      transitionDelivery(sending, "delivered", {
        at: later,
        providerMessageId: "provider-message-1"
      })
    ).toMatchObject({
      status: "delivered",
      providerMessageId: "provider-message-1",
      errorCode: null
    });
  });

  it("requires an error code before retry and rejects terminal transitions", () => {
    const sending = transitionDelivery(delivery("pending"), "sending", { at: now });
    expect(() => transitionDelivery(sending, "retry_wait", { at: later })).toThrowError(
      /stable error code/
    );
    const failed = transitionDelivery(sending, "failed", {
      at: later,
      errorCode: "CHANNEL_DELIVERY_FAILED"
    });
    expect(() => transitionDelivery(failed, "sending", { at: later })).toThrow(
      StateTransitionError
    );
  });
});

describe("vNext stable error model", () => {
  it("defines a complete, actionable disposition for every stable code", () => {
    for (const code of stableErrorCodes) {
      const disposition = getErrorDisposition(code);
      expect(typeof disposition.retryable).toBe("boolean");
      expect(typeof disposition.userActionRequired).toBe("boolean");
      expect(typeof disposition.affectsOtherChannels).toBe("boolean");
      expect(disposition.suggestedAction.length).toBeGreaterThan(0);
    }
  });
});

function binding(
  bindingId: string,
  bindingSpaceId: typeof spaceId,
  threadId: string,
  mode: ThreadBinding["mode"]
): ThreadBinding {
  return {
    bindingId,
    spaceId: bindingSpaceId,
    threadId,
    threadTitle: threadId,
    mode,
    status: "active",
    createdAt: now,
    updatedAt: now
  };
}

function turn(status: Turn["status"]): Turn {
  return {
    turnId: "turn-a",
    threadId: "thread-a",
    spaceId,
    inboundMessageId: "message-a",
    status,
    transport: "app-server",
    errorCode: null,
    queuedAt: now,
    startedAt: status === "queued" ? null : now,
    completedAt: ["completed", "failed", "interrupted"].includes(status) ? now : null
  };
}

function delivery(status: Delivery["status"]): Delivery {
  return {
    deliveryId: "delivery-a",
    deliveryKey: "delivery-key-a",
    spaceId,
    status,
    providerMessageId: status === "delivered" ? "provider-message-a" : null,
    attempts: status === "pending" ? 0 : 1,
    errorCode: status === "failed" ? "CHANNEL_DELIVERY_FAILED" : null,
    createdAt: now,
    updatedAt: now
  };
}
