export const stableErrorCodes = [
  "CHANNEL_AUTH_REQUIRED",
  "CHANNEL_RATE_LIMITED",
  "CHANNEL_DELIVERY_FAILED",
  "CODEX_UNAVAILABLE",
  "CODEX_THREAD_NOT_FOUND",
  "CODEX_TURN_BUSY",
  "CODEX_TURN_TIMEOUT",
  "ROUTER_UNAVAILABLE",
  "ROUTER_INVALID_OUTPUT",
  "ROUTER_AMBIGUOUS",
  "BINDING_CONFLICT",
  "CONFIG_INVALID",
  "CONFIG_APPLY_FAILED",
  "MEDIA_REJECTED"
] as const;

export type StableErrorCode = (typeof stableErrorCodes)[number];

export type ErrorDisposition = {
  retryable: boolean;
  userActionRequired: boolean;
  affectsOtherChannels: boolean;
  suggestedAction: string;
};

const errorDispositions: Record<StableErrorCode, ErrorDisposition> = {
  CHANNEL_AUTH_REQUIRED: disposition(false, true, false, "Reconnect the affected channel account"),
  CHANNEL_RATE_LIMITED: disposition(true, false, false, "Wait for the channel retry window"),
  CHANNEL_DELIVERY_FAILED: disposition(true, false, false, "Retry the failed delivery"),
  CODEX_UNAVAILABLE: disposition(true, false, true, "Restore Codex AppServer availability"),
  CODEX_THREAD_NOT_FOUND: disposition(false, true, false, "Bind the space to an existing thread"),
  CODEX_TURN_BUSY: disposition(true, false, false, "Wait for the active thread turn"),
  CODEX_TURN_TIMEOUT: disposition(true, false, false, "Inspect the turn before retrying"),
  ROUTER_UNAVAILABLE: disposition(true, false, false, "Use chat or an explicit command"),
  ROUTER_INVALID_OUTPUT: disposition(false, false, false, "Use an explicit command and inspect Router diagnostics"),
  ROUTER_AMBIGUOUS: disposition(false, true, false, "Choose one of the returned candidates"),
  BINDING_CONFLICT: disposition(false, true, false, "Detach the conflicting binding or explicitly enable sharing"),
  CONFIG_INVALID: disposition(false, true, true, "Correct the invalid configuration fields"),
  CONFIG_APPLY_FAILED: disposition(true, true, true, "Review the apply plan failure and retry"),
  MEDIA_REJECTED: disposition(false, true, false, "Use a supported file within the media limits")
};

export function getErrorDisposition(code: StableErrorCode): ErrorDisposition {
  return errorDispositions[code];
}

export class VNextDomainError extends Error {
  constructor(
    readonly code: StableErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>
  ) {
    super(message);
    this.name = "VNextDomainError";
  }
}

export class StateTransitionError extends Error {
  constructor(
    readonly aggregate: "turn" | "delivery",
    readonly from: string,
    readonly to: string,
    message = `Invalid ${aggregate} transition: ${from} -> ${to}`
  ) {
    super(message);
    this.name = "StateTransitionError";
  }
}

function disposition(
  retryable: boolean,
  userActionRequired: boolean,
  affectsOtherChannels: boolean,
  suggestedAction: string
): ErrorDisposition {
  return { retryable, userActionRequired, affectsOtherChannels, suggestedAction };
}
