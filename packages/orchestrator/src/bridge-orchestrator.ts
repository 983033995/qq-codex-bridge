import { BridgeSessionStatus, type BridgeSession } from "../../domain/src/session.js";
import type { InboundMessage, OutboundDraft } from "../../domain/src/message.js";
import { DesktopDriverError } from "../../domain/src/driver.js";
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
  private readonly recentInboundFingerprints = new Map<
    string,
    { fingerprint: string; receivedAtMs: number; messageId: string }
  >();

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

      if (this.isLikelyDuplicateInbound(message)) {
        console.warn("[qq-codex-bridge] duplicate inbound suppressed", {
          messageId: message.messageId,
          sessionKey: message.sessionKey
        });
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
          skillContextKey: null,
          status: BridgeSessionStatus.Active,
          lastInboundAt: message.receivedAt,
          lastOutboundAt: null,
          lastError: null
        };

        await this.deps.sessionStore.createSession(created);
      }

      await this.deps.transcriptStore.recordInbound(message);
      this.rememberInbound(message);

      try {
        const deliveredDraftIds = new Set<string>();
        const deliveryErrors: string[] = [];
        const handleDraft = async (draft: OutboundDraft) => {
          if (deliveredDraftIds.has(draft.draftId)) {
            return;
          }
          deliveredDraftIds.add(draft.draftId);
          await this.deps.transcriptStore.recordOutbound(draft);
          try {
            await this.deps.qqEgress.deliver(draft);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            deliveryErrors.push(`${draft.draftId}: ${reason}`);
            console.warn("[qq-codex-bridge] draft delivery failed", {
              sessionKey: message.sessionKey,
              messageId: message.messageId,
              draftId: draft.draftId,
              error: reason
            });
          }
        };

        const drafts = await this.deps.conversationProvider.runTurn(message, {
          onDraft: handleDraft
        });

        for (const draft of drafts) {
          await handleDraft(draft);
        }

        await this.deps.sessionStore.updateSessionStatus(
          message.sessionKey,
          BridgeSessionStatus.Active,
          deliveryErrors.length > 0 ? deliveryErrors.at(-1) ?? null : null
        );
      } catch (error) {
        const lastError = error instanceof Error ? error.message : String(error);
        if (isRecoverableTurnError(error)) {
          await this.deps.sessionStore.updateSessionStatus(
            message.sessionKey,
            BridgeSessionStatus.Active,
            lastError
          );
          console.warn("[qq-codex-bridge] recoverable turn error", {
            messageId: message.messageId,
            sessionKey: message.sessionKey,
            error: lastError
          });
          return;
        }

        await this.deps.sessionStore.updateSessionStatus(
          message.sessionKey,
          BridgeSessionStatus.NeedsRebind,
          lastError
        );
        throw error;
      }
    });
  }

  private isLikelyDuplicateInbound(message: InboundMessage): boolean {
    const record = this.recentInboundFingerprints.get(message.sessionKey);
    if (!record) {
      return false;
    }

    const receivedAtMs = Date.parse(message.receivedAt);
    if (!Number.isFinite(receivedAtMs)) {
      return false;
    }

    return (
      record.fingerprint === buildInboundFingerprint(message) &&
      receivedAtMs - record.receivedAtMs >= 0 &&
      receivedAtMs - record.receivedAtMs <= 90_000
    );
  }

  private rememberInbound(message: InboundMessage): void {
    const receivedAtMs = Date.parse(message.receivedAt);
    if (!Number.isFinite(receivedAtMs)) {
      return;
    }

    const now = receivedAtMs;
    for (const [sessionKey, record] of this.recentInboundFingerprints.entries()) {
      if (now - record.receivedAtMs > 120_000) {
        this.recentInboundFingerprints.delete(sessionKey);
      }
    }

    this.recentInboundFingerprints.set(message.sessionKey, {
      fingerprint: buildInboundFingerprint(message),
      receivedAtMs,
      messageId: message.messageId
    });
  }
}

function isRecoverableTurnError(error: unknown): boolean {
  return error instanceof DesktopDriverError && error.reason === "reply_timeout";
}

function buildInboundFingerprint(message: InboundMessage): string {
  const mediaFingerprint = (message.mediaArtifacts ?? [])
    .map((artifact) =>
      [
        artifact.kind,
        artifact.localPath || "",
        artifact.sourceUrl || "",
        artifact.originalName || ""
      ].join("::")
    )
    .join("|");

  return [
    message.accountKey,
    message.sessionKey,
    message.senderId,
    message.chatType,
    message.text.trim(),
    mediaFingerprint
  ].join("||");
}
