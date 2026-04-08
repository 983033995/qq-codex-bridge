import { randomUUID } from "node:crypto";
import type { DriverBinding } from "../../../domain/src/driver.js";
import type { InboundMessage, OutboundDraft } from "../../../domain/src/message.js";
import type { DesktopDriverPort } from "../../../ports/src/conversation.js";
import { CdpSession } from "./cdp-session.js";

export class CodexDesktopDriver implements DesktopDriverPort {
  constructor(private readonly cdp: CdpSession) {}

  async ensureAppReady(): Promise<void> {
    await this.cdp.connect();
  }

  async openOrBindSession(
    sessionKey: string,
    binding: DriverBinding | null
  ): Promise<DriverBinding> {
    return {
      sessionKey,
      codexThreadRef: binding?.codexThreadRef ?? `codex-thread:${randomUUID()}`
    };
  }

  async sendUserMessage(_binding: DriverBinding, _message: InboundMessage): Promise<void> {
    return;
  }

  async collectAssistantReply(binding: DriverBinding): Promise<OutboundDraft[]> {
    return [
      {
        draftId: randomUUID(),
        sessionKey: binding.sessionKey,
        text: "stubbed desktop reply",
        createdAt: new Date().toISOString()
      }
    ];
  }

  async markSessionBroken(_sessionKey: string, _reason: string): Promise<void> {
    return;
  }
}
