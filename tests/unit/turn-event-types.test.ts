import { describe, expect, it } from "vitest";
import { TurnEventType, type TurnEvent } from "../../packages/domain/src/message.js";

describe("turn event model", () => {
  it("supports delta and completed events with stable keys", () => {
    const event: TurnEvent = {
      sessionKey: "qqbot:default::qq:c2c:123",
      turnId: "turn-1",
      sequence: 2,
      eventType: TurnEventType.Delta,
      createdAt: "2026-04-12T00:00:00.000Z",
      isFinal: false,
      payload: {
        text: "第二段",
        fullText: "第一段第二段",
        mediaReferences: []
      }
    };

    expect(event.eventType).toBe(TurnEventType.Delta);
    expect(event.payload.fullText).toContain("第一段");
  });
});
