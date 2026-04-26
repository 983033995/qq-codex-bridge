import { randomUUID } from "node:crypto";
import { BridgeSessionStatus, type BridgeSession } from "../../domain/src/session.js";
import {
  TurnEventType,
  type InboundMessage,
  type MediaArtifact,
  type OutboundDraft,
  type TurnEvent
} from "../../domain/src/message.js";
import { DesktopDriverError } from "../../domain/src/driver.js";
import type { ConversationProviderPort } from "../../ports/src/conversation.js";
import type { QqEgressPort } from "../../ports/src/qq.js";
import type { SessionStorePort, TranscriptStorePort } from "../../ports/src/store.js";

type BridgeOrchestratorDeps = {
  sessionStore: SessionStorePort;
  transcriptStore: TranscriptStorePort;
  conversationProvider: ConversationProviderPort;
  qqEgress: QqEgressPort;
  draftFormatter?: (draft: OutboundDraft) => OutboundDraft;
};

type TurnState = {
  lastSequence: number;
  assembledText: string;
  sentText: string;
  sentArtifactKeys: Set<string>;
  lastEventAt: string | null;
  completed: boolean;
  finalFlushed: boolean;
};

export class BridgeOrchestrator {
  private readonly recentInboundFingerprints = new Map<
    string,
    Array<{ fingerprint: string; receivedAtMs: number; messageId: string }>
  >();
  private readonly turnStates = new Map<string, TurnState>();
  private readonly draftFormatter: (draft: OutboundDraft) => OutboundDraft;

  constructor(private readonly deps: BridgeOrchestratorDeps) {
    this.draftFormatter = deps.draftFormatter ?? ((draft) => draft);
  }

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
          lastCodexTurnId: null,
          skillContextKey: null,
          conversationProvider: null,
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
          if (draft.turnId) {
            await this.deps.sessionStore.updateLastCodexTurnId(message.sessionKey, draft.turnId);
          }
          const formattedDraft = this.draftFormatter(draft);
          if (isEmptyDraft(formattedDraft)) {
            return;
          }
          await this.deps.transcriptStore.recordOutbound(formattedDraft);
          try {
            await this.deps.qqEgress.deliver(formattedDraft);
            this.recordDeliveredDraft(formattedDraft);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            deliveryErrors.push(`${formattedDraft.draftId}: ${reason}`);
            console.warn("[qq-codex-bridge] draft delivery failed", {
              sessionKey: message.sessionKey,
              messageId: message.messageId,
              draftId: formattedDraft.draftId,
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

      await this.deps.sessionStore.updateLastCodexTurnId(event.sessionKey, event.turnId);

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

      const draft = this.draftFormatter({
        draftId: randomUUID(),
        turnId: event.turnId,
        sessionKey: event.sessionKey,
        text: pendingText,
        createdAt: event.createdAt,
        ...(event.payload.replyToMessageId
          ? { replyToMessageId: event.payload.replyToMessageId }
          : {})
      });

      const pendingArtifacts = filterPendingArtifacts(draft.mediaArtifacts ?? [], state.sentArtifactKeys);
      const normalizedDraft =
        pendingArtifacts.length === (draft.mediaArtifacts?.length ?? 0)
          ? draft
          : {
              ...draft,
              mediaArtifacts: pendingArtifacts
            };

      if (isEmptyDraft(normalizedDraft)) {
        state.sentText = state.assembledText;
        state.completed = true;
        state.finalFlushed = true;
        return;
      }

      await this.deps.transcriptStore.recordOutbound(normalizedDraft);
      await this.deps.qqEgress.deliver(normalizedDraft);
      this.recordDeliveredDraft(normalizedDraft);
      state.sentText = state.assembledText;
      state.completed = true;
      state.finalFlushed = true;
    });
  }

  private isLikelyDuplicateInbound(message: InboundMessage): boolean {
    const receivedAtMs = Date.parse(message.receivedAt);
    if (!Number.isFinite(receivedAtMs)) {
      return false;
    }

    const records = this.getRecentInboundRecords(message.sessionKey, receivedAtMs);
    if (!records.length) {
      return false;
    }

    const fingerprint = buildInboundFingerprint(message);
    return records.some(
      (record) =>
        record.fingerprint === fingerprint
        && receivedAtMs - record.receivedAtMs >= 0
        && receivedAtMs - record.receivedAtMs <= 90_000
    );
  }

  private rememberInbound(message: InboundMessage): void {
    const receivedAtMs = Date.parse(message.receivedAt);
    if (!Number.isFinite(receivedAtMs)) {
      return;
    }

    const records = this.getRecentInboundRecords(message.sessionKey, receivedAtMs);
    records.push({
      fingerprint: buildInboundFingerprint(message),
      receivedAtMs,
      messageId: message.messageId
    });
    this.recentInboundFingerprints.set(message.sessionKey, records);
  }

  private getRecentInboundRecords(
    sessionKey: string,
    referenceTimeMs: number
  ): Array<{ fingerprint: string; receivedAtMs: number; messageId: string }> {
    for (const [key, records] of this.recentInboundFingerprints.entries()) {
      const retained = records.filter((record) => referenceTimeMs - record.receivedAtMs <= 120_000);
      if (retained.length > 0) {
        this.recentInboundFingerprints.set(key, retained);
      } else {
        this.recentInboundFingerprints.delete(key);
      }
    }

    return [...(this.recentInboundFingerprints.get(sessionKey) ?? [])];
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
      sentArtifactKeys: new Set<string>(),
      lastEventAt: null,
      completed: false,
      finalFlushed: false
    };
    this.turnStates.set(key, created);
    return created;
  }

  private recordDeliveredDraft(draft: OutboundDraft): void {
    if (!draft.turnId) {
      return;
    }

    const key = buildTurnStateKey(draft.sessionKey, draft.turnId);
    const state = this.turnStates.get(key) ?? {
      lastSequence: 0,
      assembledText: "",
      sentText: "",
      sentArtifactKeys: new Set<string>(),
      lastEventAt: null,
      completed: false,
      finalFlushed: false
    };
    state.sentText += draft.text;
    for (const artifact of draft.mediaArtifacts ?? []) {
      state.sentArtifactKeys.add(buildArtifactKey(artifact));
    }
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

function filterPendingArtifacts(
  artifacts: MediaArtifact[],
  sentArtifactKeys: Set<string>
): MediaArtifact[] {
  return artifacts.filter((artifact) => !sentArtifactKeys.has(buildArtifactKey(artifact)));
}

function buildArtifactKey(artifact: MediaArtifact): string {
  return [
    artifact.kind,
    artifact.localPath || "",
    artifact.sourceUrl || "",
    artifact.originalName || ""
  ].join("::");
}

function isEmptyDraft(draft: OutboundDraft): boolean {
  return !draft.text.trim() && !(draft.mediaArtifacts?.length);
}
