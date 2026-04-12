import { randomUUID } from "node:crypto";
import { BridgeSessionStatus, type BridgeSession } from "../../domain/src/session.js";
import { TurnEventType, type InboundMessage, type OutboundDraft, type TurnEvent } from "../../domain/src/message.js";
import { DesktopDriverError } from "../../domain/src/driver.js";
import type { ConversationProviderPort } from "../../ports/src/conversation.js";
import type { QqEgressPort } from "../../ports/src/qq.js";
import type { SessionStorePort, TranscriptStorePort } from "../../ports/src/store.js";
import { formatQqOutboundDraft } from "./qq-outbound-format.js";

type BridgeOrchestratorDeps = {
  sessionStore: SessionStorePort;
  transcriptStore: TranscriptStorePort;
  conversationProvider: ConversationProviderPort;
  qqEgress: QqEgressPort;
};

type TurnState = {
  lastSequence: number;
  assembledText: string;
  sentText: string;
  lastEventAt: string | null;
  completed: boolean;
  finalFlushed: boolean;
};

export class BridgeOrchestrator {
  private readonly recentInboundFingerprints = new Map<
    string,
    { fingerprint: string; receivedAtMs: number; messageId: string }
  >();
  private readonly turnStates = new Map<string, TurnState>();

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
            this.recordDeliveredDraft(draft);
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

  async handleTurnEvent(event: TurnEvent): Promise<void> {
    await this.deps.sessionStore.withSessionLock(event.sessionKey, async () => {
      const state = this.getOrCreateTurnState(event);
      if (event.sequence <= state.lastSequence) {
        return;
      }

      state.lastSequence = event.sequence;
      state.lastEventAt = event.createdAt;
      if (typeof event.payload.fullText === "string") {
        state.assembledText = event.payload.fullText;
      } else if (typeof event.payload.text === "string" && event.payload.text.length > 0) {
        state.assembledText += event.payload.text;
      }

      if (event.eventType !== TurnEventType.Completed) {
        return;
      }

      const pendingText = computePendingTurnText(state.sentText, state.assembledText);
      if (!pendingText) {
        state.completed = true;
        state.finalFlushed = true;
        return;
      }

      const draft = formatQqOutboundDraft({
        draftId: randomUUID(),
        turnId: event.turnId,
        sessionKey: event.sessionKey,
        text: pendingText,
        createdAt: event.createdAt,
        ...(event.payload.replyToMessageId
          ? { replyToMessageId: event.payload.replyToMessageId }
          : {})
      });

      if (!draft.text.trim()) {
        state.sentText = state.assembledText;
        state.completed = true;
        state.finalFlushed = true;
        return;
      }

      await this.deps.transcriptStore.recordOutbound(draft);
      await this.deps.qqEgress.deliver(draft);
      state.sentText = state.assembledText;
      state.completed = true;
      state.finalFlushed = true;
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

  private getOrCreateTurnState(event: TurnEvent): TurnState {
    const key = buildTurnStateKey(event.sessionKey, event.turnId);
    const existing = this.turnStates.get(key);
    if (existing) {
      return existing;
    }

    const created: TurnState = {
      lastSequence: 0,
      assembledText: "",
      sentText: "",
      lastEventAt: null,
      completed: false,
      finalFlushed: false
    };
    this.turnStates.set(key, created);
    return created;
  }

  private recordDeliveredDraft(draft: OutboundDraft): void {
    if (!draft.turnId || !draft.text) {
      return;
    }

    const key = buildTurnStateKey(draft.sessionKey, draft.turnId);
    const state = this.turnStates.get(key) ?? {
      lastSequence: 0,
      assembledText: "",
      sentText: "",
      lastEventAt: null,
      completed: false,
      finalFlushed: false
    };
    state.sentText += draft.text;
    this.turnStates.set(key, state);
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

function buildTurnStateKey(sessionKey: string, turnId: string): string {
  return `${sessionKey}::${turnId}`;
}

function computePendingTurnText(sentText: string, fullText: string): string {
  if (!fullText) {
    return "";
  }

  if (!sentText) {
    return fullText;
  }

  if (fullText.startsWith(sentText)) {
    return fullText.slice(sentText.length);
  }

  if (stripWhitespace(fullText) === stripWhitespace(sentText)) {
    return "";
  }

  const overlap = findSuffixPrefixOverlap(sentText, fullText);
  if (overlap > 0) {
    return fullText.slice(overlap);
  }

  return fullText;
}

function findSuffixPrefixOverlap(previous: string, next: string): number {
  const maxLength = Math.min(previous.length, next.length);
  for (let length = maxLength; length > 0; length -= 1) {
    if (previous.slice(-length) === next.slice(0, length)) {
      return length;
    }
  }

  return 0;
}

function stripWhitespace(value: string): string {
  return value.replace(/\s+/g, "");
}
