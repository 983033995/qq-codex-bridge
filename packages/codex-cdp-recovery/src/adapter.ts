import { randomUUID } from "node:crypto";
import type {
  CodexControlState as DesktopControlState,
  CodexThreadSummary,
  DriverBinding
} from "../../domain/src/driver.js";
import { DesktopDriverError } from "../../domain/src/driver.js";
import type { InboundMessage, OutboundDraft } from "../../domain/src/message.js";
import type {
  CodexControlState,
  CodexRecoveryCapabilities,
  CodexRecoveryHealth,
  CodexRecoveryPort,
  CodexTurnHandle,
  StartCodexRecoveryTurnInput
} from "../../ports/src/vnext/index.js";

export type CdpRecoveryErrorCode =
  | "unsupported_content"
  | "thread_not_found"
  | "thread_ambiguous"
  | "submit_failed"
  | "reply_failed";

export class CdpRecoveryError extends Error {
  readonly transport = "cdp-recovery" as const;

  constructor(
    message: string,
    readonly code: CdpRecoveryErrorCode,
    readonly accepted: boolean,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "CdpRecoveryError";
  }
}

export type CdpRecoveryDesktopDriver = {
  ensureAppReady(): Promise<void>;
  listRecentThreads(limit: number): Promise<CodexThreadSummary[]>;
  switchToThread(sessionKey: string, threadRef: string): Promise<DriverBinding>;
  submitUserMessageOnce(binding: DriverBinding, message: InboundMessage): Promise<void>;
  collectAssistantReply(binding: DriverBinding): Promise<OutboundDraft[]>;
  getControlState(binding?: DriverBinding | null): Promise<DesktopControlState>;
};

export type CdpRecoveryAdapterOptions = {
  now?: () => Date;
  nextTurnId?: () => string;
};

const CAPABILITIES: CodexRecoveryCapabilities = {
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
};

export class CdpRecoveryAdapter implements CodexRecoveryPort {
  private readonly now: () => Date;
  private readonly nextTurnId: () => string;
  private readonly since: string;
  private turnTail = Promise.resolve();

  constructor(
    private readonly driver: CdpRecoveryDesktopDriver,
    options: CdpRecoveryAdapterOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.nextTurnId = options.nextTurnId ?? randomUUID;
    this.since = this.now().toISOString();
  }

  async health(): Promise<CodexRecoveryHealth> {
    return {
      component: "codex-cdp-recovery",
      status: "degraded",
      code: "CDP_RECOVERY_ONLY",
      message: "CDP Recovery is a globally serialized, reduced-capability transport",
      since: this.since,
      suggestedAction: "Restore Codex AppServer for full capabilities and parallel turns",
      capabilities: { ...CAPABILITIES }
    };
  }

  async getControlState(): Promise<CodexControlState> {
    const state = await this.driver.getControlState(null);
    return {
      model: state.model,
      reasoningEffort: state.reasoningEffort,
      quotaSummary: state.quotaSummary
    };
  }

  async startRecoveryTurn(input: StartCodexRecoveryTurnInput): Promise<CodexTurnHandle> {
    const normalized = validateInput(input);
    const release = await this.acquireTurn();
    let binding: DriverBinding;
    try {
      binding = await this.selectKnownThread(normalized);
    } catch (error) {
      release();
      throw toRecoveryError(error, "thread_not_found", false);
    }

    try {
      await this.driver.submitUserMessageOnce(
        binding,
        toDesktopMessage(normalized, binding.sessionKey, this.now().toISOString())
      );
    } catch (error) {
      release();
      const accepted = !isDefinitelyPreSubmitDesktopError(error);
      throw toRecoveryError(error, "submit_failed", accepted);
    }

    const turnId = this.nextTurnId();
    const acceptedAt = this.now().toISOString();
    const completion = this.collectFinalReply(
      binding,
      normalized.threadId,
      turnId
    ).finally(release);
    void completion.catch(() => undefined);
    return {
      threadId: normalized.threadId,
      turnId,
      acceptedAt,
      completion
    };
  }

  private async selectKnownThread(
    input: StartCodexRecoveryTurnInput
  ): Promise<DriverBinding> {
    await this.driver.ensureAppReady();
    const expectedTitle = normalizeText(input.threadTitle);
    const matches = (await this.driver.listRecentThreads(200)).filter(
      (thread) => normalizeText(thread.title) === expectedTitle
    );
    if (matches.length === 0) {
      throw new CdpRecoveryError(
        `Known Codex thread '${input.threadId}' is not visible in the desktop sidebar`,
        "thread_not_found",
        false
      );
    }
    if (matches.length > 1) {
      throw new CdpRecoveryError(
        `Known Codex thread '${input.threadId}' cannot be selected because title '${input.threadTitle}' is ambiguous`,
        "thread_ambiguous",
        false
      );
    }
    return this.driver.switchToThread(
      `cdp-recovery:${input.idempotencyKey}`,
      matches[0]!.threadRef
    );
  }

  private async collectFinalReply(
    binding: DriverBinding,
    threadId: string,
    turnId: string
  ) {
    let drafts: OutboundDraft[];
    try {
      drafts = await this.driver.collectAssistantReply(binding);
    } catch (error) {
      throw toRecoveryError(error, "reply_failed", true);
    }
    const final = drafts.at(-1);
    if (!final) {
      throw new CdpRecoveryError(
        "Codex desktop did not return a final reply",
        "reply_failed",
        true
      );
    }
    return {
      threadId,
      turnId,
      finalText: final.text,
      mediaReferences: [...new Set(
        (final.mediaArtifacts ?? []).map((artifact) => artifact.localPath || artifact.sourceUrl)
      )]
    };
  }

  private async acquireTurn(): Promise<() => void> {
    const previous = this.turnTail;
    let releaseTail!: () => void;
    this.turnTail = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    await previous;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        releaseTail();
      }
    };
  }
}

function validateInput(input: StartCodexRecoveryTurnInput): StartCodexRecoveryTurnInput {
  const threadId = requireNonEmpty(input.threadId, "threadId");
  const threadTitle = requireNonEmpty(input.threadTitle, "threadTitle");
  const idempotencyKey = requireNonEmpty(input.idempotencyKey, "idempotencyKey");
  const text = requireNonEmpty(input.content.text, "content.text");
  if (input.content.attachments.length > 0 || input.content.mentions.length > 0) {
    throw new CdpRecoveryError(
      "CDP Recovery supports plain text only",
      "unsupported_content",
      false
    );
  }
  return {
    threadId,
    threadTitle,
    idempotencyKey,
    content: { text, mentions: [], attachments: [] }
  };
}

function toDesktopMessage(
  input: StartCodexRecoveryTurnInput,
  sessionKey: string,
  receivedAt: string
): InboundMessage {
  return {
    messageId: input.idempotencyKey,
    accountKey: "vnext:cdp-recovery",
    sessionKey,
    peerKey: `codex-thread:${input.threadId}`,
    chatType: "c2c",
    senderId: "vnext",
    text: input.content.text,
    receivedAt
  };
}

function isDefinitelyPreSubmitDesktopError(error: unknown): boolean {
  return error instanceof DesktopDriverError
    && ["app_not_ready", "session_not_found", "input_not_found"].includes(error.reason);
}

function toRecoveryError(
  error: unknown,
  code: CdpRecoveryErrorCode,
  accepted: boolean
): CdpRecoveryError {
  if (error instanceof CdpRecoveryError) {
    return error;
  }
  return new CdpRecoveryError(
    error instanceof Error ? error.message : String(error),
    code,
    accepted,
    error instanceof Error ? { cause: error } : undefined
  );
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new CdpRecoveryError(`${field} is required`, "unsupported_content", false);
  }
  return normalized;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
