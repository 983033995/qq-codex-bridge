import type {
  ConversationSpace,
  ConversationSpaceId,
  Delivery,
  InboundEnvelope,
  RoutingDecision,
  ThreadBinding,
  Turn
} from "../../../domain/src/vnext/index.js";

export type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
};

export interface ConversationSpaceRepository {
  get(spaceId: ConversationSpaceId): Promise<ConversationSpace | null>;
  save(space: ConversationSpace): Promise<void>;
  list(input: { limit: number; cursor?: string }): Promise<CursorPage<ConversationSpace>>;
}

export interface ThreadBindingRepository {
  getActiveBySpace(spaceId: ConversationSpaceId): Promise<ThreadBinding | null>;
  listActiveByThread(threadId: string): Promise<ThreadBinding[]>;
  save(binding: ThreadBinding): Promise<void>;
  detach(bindingId: string, updatedAt: string): Promise<boolean>;
}

export interface MessageLedger {
  findByDedupeKey(dedupeKey: string): Promise<InboundEnvelope | null>;
  appendInbound(message: InboundEnvelope, dedupeKey: string): Promise<boolean>;
  listBySpace(input: {
    spaceId: ConversationSpaceId;
    limit: number;
    cursor?: string;
  }): Promise<CursorPage<InboundEnvelope>>;
}

export interface TurnRepository {
  get(turnId: string): Promise<Turn | null>;
  save(turn: Turn): Promise<void>;
  listActiveByThread(threadId: string): Promise<Turn[]>;
  listRecoverable(): Promise<Turn[]>;
}

export type RoutingDecisionRecord = {
  decisionId: string;
  spaceId: ConversationSpaceId;
  messageId: string;
  decision: RoutingDecision;
  latencyMs: number;
  confirmationStatus: "not_required" | "pending" | "confirmed" | "cancelled" | "expired";
  result: string | null;
  createdAt: string;
};

export interface RoutingDecisionRepository {
  save(record: RoutingDecisionRecord): Promise<void>;
  list(input: { limit: number; cursor?: string }): Promise<CursorPage<RoutingDecisionRecord>>;
}

export interface DeliveryRepository {
  get(deliveryId: string): Promise<Delivery | null>;
  findByKey(deliveryKey: string): Promise<Delivery | null>;
  save(delivery: Delivery): Promise<void>;
}

export type PushTargetRecord = {
  alias: string;
  spaceId: ConversationSpaceId;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PushJobRecord = {
  pushId: string;
  idempotencyKey: string;
  targetAlias: string;
  status: "queued" | "sending" | "retry_wait" | "delivered" | "failed";
  contentJson: string;
  attemptCount: number;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export interface PushRepository {
  getTarget(alias: string): Promise<PushTargetRecord | null>;
  listTargets(): Promise<PushTargetRecord[]>;
  saveTarget(target: PushTargetRecord): Promise<void>;
  enqueue(job: PushJobRecord): Promise<{ job: PushJobRecord; duplicate: boolean }>;
  getJob(pushId: string): Promise<PushJobRecord | null>;
}

export type RuntimeEventRecord = {
  eventId: string;
  component: string;
  type: string;
  payloadJson: string;
  createdAt: string;
};

export interface RuntimeEventRepository {
  append(event: RuntimeEventRecord): Promise<void>;
  list(input: { limit: number; cursor?: string }): Promise<CursorPage<RuntimeEventRecord>>;
}
