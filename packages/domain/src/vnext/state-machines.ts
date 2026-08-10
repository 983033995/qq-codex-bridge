import { StateTransitionError } from "./errors.js";
import type {
  Delivery,
  DeliveryStatus,
  Turn,
  TurnStatus
} from "./models.js";
import type { StableErrorCode } from "./errors.js";

const turnTransitions: Record<TurnStatus, readonly TurnStatus[]> = {
  queued: ["starting", "failed", "interrupted"],
  starting: ["running", "unknown", "failed", "interrupted"],
  running: ["unknown", "completed", "failed", "interrupted"],
  unknown: ["completed", "failed", "interrupted"],
  completed: [],
  failed: [],
  interrupted: []
};

const deliveryTransitions: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  pending: ["sending", "failed"],
  sending: ["delivered", "retry_wait", "failed"],
  retry_wait: ["sending", "failed"],
  delivered: [],
  failed: []
};

export function canTransitionTurn(from: TurnStatus, to: TurnStatus): boolean {
  return turnTransitions[from].includes(to);
}

export function transitionTurn(
  turn: Turn,
  nextStatus: TurnStatus,
  options: {
    at: string;
    errorCode?: StableErrorCode;
  }
): Turn {
  if (!canTransitionTurn(turn.status, nextStatus)) {
    throw new StateTransitionError("turn", turn.status, nextStatus);
  }
  if (nextStatus === "failed" && !options.errorCode) {
    throw new StateTransitionError(
      "turn",
      turn.status,
      nextStatus,
      "A failed turn requires a stable error code"
    );
  }

  const starts = nextStatus === "starting" || nextStatus === "running";
  const finishes = ["completed", "failed", "interrupted"].includes(nextStatus);
  return {
    ...turn,
    status: nextStatus,
    startedAt: starts ? turn.startedAt ?? options.at : turn.startedAt,
    completedAt: finishes ? options.at : null,
    errorCode: nextStatus === "failed" ? options.errorCode! : null
  };
}

export function canTransitionDelivery(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return deliveryTransitions[from].includes(to);
}

export function transitionDelivery(
  delivery: Delivery,
  nextStatus: DeliveryStatus,
  options: {
    at: string;
    providerMessageId?: string;
    errorCode?: StableErrorCode;
  }
): Delivery {
  if (!canTransitionDelivery(delivery.status, nextStatus)) {
    throw new StateTransitionError("delivery", delivery.status, nextStatus);
  }
  if (nextStatus === "delivered" && !options.providerMessageId) {
    throw new StateTransitionError(
      "delivery",
      delivery.status,
      nextStatus,
      "A delivered delivery requires a provider message id"
    );
  }
  if (["retry_wait", "failed"].includes(nextStatus) && !options.errorCode) {
    throw new StateTransitionError(
      "delivery",
      delivery.status,
      nextStatus,
      `A ${nextStatus} delivery requires a stable error code`
    );
  }

  return {
    ...delivery,
    status: nextStatus,
    attempts: nextStatus === "sending" ? delivery.attempts + 1 : delivery.attempts,
    providerMessageId:
      nextStatus === "delivered" ? options.providerMessageId! : delivery.providerMessageId,
    errorCode: ["retry_wait", "failed"].includes(nextStatus)
      ? options.errorCode!
      : null,
    updatedAt: options.at
  };
}
