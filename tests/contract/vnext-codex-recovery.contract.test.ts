import { describe, expect, it } from "vitest";
import type { CodexThreadSummary, DriverBinding } from "../../packages/domain/src/driver.js";
import type { InboundMessage } from "../../packages/domain/src/message.js";
import {
  CdpRecoveryAdapter,
  type CdpRecoveryDesktopDriver
} from "../../packages/codex-cdp-recovery/src/index.js";

describe("vNext CDP Recovery port contract", () => {
  it("exposes only reduced degraded recovery capabilities", async () => {
    const port = createPort();
    const health = await port.health();

    expect(health.status).toBe("degraded");
    expect(health.capabilities).toEqual({
      selectKnownThread: true,
      submitText: true,
      collectFinalReply: true,
      controlState: true,
      createThread: false,
      renameThread: false,
      forkThread: false,
      concurrentTurns: false,
      preciseTurnEvents: false,
      media: false
    });
    expect(Object.keys(port).filter((key) => [
      "createThread",
      "renameThread",
      "forkThread",
      "listThreads",
      "switchModel"
    ].includes(key))).toEqual([]);
  });

  it("returns an accepted handle only after selecting and submitting a known text turn", async () => {
    const driver = new ContractDriver();
    const port = createPort(driver);
    const handle = await port.startRecoveryTurn({
      threadId: "thread-contract",
      threadTitle: "Contract Thread",
      idempotencyKey: "contract-message",
      content: { text: "contract text", mentions: [], attachments: [] }
    });

    expect(driver.events).toEqual(["ready", "list", "select", "submit", "collect"]);
    await expect(handle.completion).resolves.toEqual({
      threadId: "thread-contract",
      turnId: "contract-turn",
      finalText: "contract reply",
      mediaReferences: []
    });
  });
});

function createPort(driver = new ContractDriver()): CdpRecoveryAdapter {
  return new CdpRecoveryAdapter(driver, {
    now: () => new Date("2026-08-10T06:00:00.000Z"),
    nextTurnId: () => "contract-turn"
  });
}

class ContractDriver implements CdpRecoveryDesktopDriver {
  readonly events: string[] = [];

  async ensureAppReady(): Promise<void> {
    this.events.push("ready");
  }

  async listRecentThreads(): Promise<CodexThreadSummary[]> {
    this.events.push("list");
    return [{
      index: 1,
      title: "Contract Thread",
      projectName: null,
      relativeTime: "now",
      isCurrent: true,
      threadRef: "internal-contract-ref"
    }];
  }

  async switchToThread(sessionKey: string, threadRef: string): Promise<DriverBinding> {
    this.events.push("select");
    return { sessionKey, codexThreadRef: threadRef };
  }

  async submitUserMessageOnce(_binding: DriverBinding, message: InboundMessage): Promise<void> {
    expect(message.text).toBe("contract text");
    this.events.push("submit");
  }

  async collectAssistantReply(binding: DriverBinding) {
    this.events.push("collect");
    return [{
      draftId: "draft-contract",
      sessionKey: binding.sessionKey,
      text: "contract reply",
      createdAt: "2026-08-10T06:00:00.000Z"
    }];
  }

  async getControlState() {
    return {
      model: "gpt-test",
      reasoningEffort: null,
      workspace: null,
      branch: null,
      permissionMode: null,
      quotaSummary: null
    };
  }
}
