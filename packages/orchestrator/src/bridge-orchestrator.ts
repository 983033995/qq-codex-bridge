import { BridgeSessionStatus, type BridgeSession } from "../../domain/src/session.js";
import type { InboundMessage } from "../../domain/src/message.js";
import type { ConversationProviderPort } from "../../ports/src/conversation.js";
import type { QqEgressPort } from "../../ports/src/qq.js";
import type { SessionStorePort, TranscriptStorePort } from "../../ports/src/store.js";

type BridgeOrchestratorDeps = {
  sessionStore: SessionStorePort;
  transcriptStore: TranscriptStorePort;
  conversationProvider: ConversationProviderPort;
  qqEgress: QqEgressPort;
};

export class BridgeOrchestrator {
  constructor(private readonly deps: BridgeOrchestratorDeps) {}

  async handleInbound(message: InboundMessage): Promise<void> {
    const alreadySeen = await this.deps.transcriptStore.hasInbound(message.messageId);
    if (alreadySeen) {
      return;
    }

    await this.deps.sessionStore.withSessionLock(message.sessionKey, async () => {
      const seenInsideLock = await this.deps.transcriptStore.hasInbound(message.messageId);
      if (seenInsideLock) {
        return;
      }

      const existing = await this.deps.sessionStore.getSession(message.sessionKey);
      if (!existing) {
        const created: BridgeSession = {
          sessionKey: message.sessionKey,
          accountKey: message.accountKey,
          peerKey: message.peerKey,
          chatType: message.chatType,
          peerId: message.senderId,
          codexThreadRef: null,
          status: BridgeSessionStatus.Active,
          lastInboundAt: message.receivedAt,
          lastOutboundAt: null,
          lastError: null
        };

        await this.deps.sessionStore.createSession(created);
      }

      await this.deps.transcriptStore.recordInbound(message);

      try {
        const drafts = await this.deps.conversationProvider.runTurn(message);

        for (const draft of drafts) {
          await this.deps.transcriptStore.recordOutbound(draft);
          await this.deps.qqEgress.deliver(draft);
        }

        await this.deps.sessionStore.updateSessionStatus(
          message.sessionKey,
          BridgeSessionStatus.Active,
          null
        );
      } catch (error) {
        const lastError = error instanceof Error ? error.message : String(error);
        await this.deps.sessionStore.updateSessionStatus(
          message.sessionKey,
          BridgeSessionStatus.NeedsRebind,
          lastError
        );
        throw error;
      }
    });
  }
}
