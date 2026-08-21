export type PushChannel = "qq" | "weixin" | "feishu";
export type PushTargetType = "user" | "group";
export type PushMessageFormat = "plain" | "markdown";
export type PushJobStatus = "queued" | "sending" | "retry_wait" | "delivered" | "failed";
export type PushFailureCode =
  | "channel_unsupported"
  | "media_sandbox_violation"
  | "rate_limited"
  | "temporary_failure"
  | "permanent_failure";

export type PushMediaInput = {
  type: "image" | "file" | "audio" | "video";
  path: string;
};

export type PushSourceMetadata = {
  provider: string;
  instanceId?: string;
  conversationId?: string;
  conversationAlias?: string;
  projectId?: string;
  projectName?: string;
  taskId?: string;
  taskTitle?: string;
  capability?: "interactive" | "push_only" | "system";
};

export type PushSource = string | PushSourceMetadata;

export type PushPayload = {
  message: {
    text: string;
    format: PushMessageFormat;
    media: PushMediaInput[];
  };
  metadata: {
    source?: PushSource;
    taskId?: string;
    priority?: "normal" | "urgent";
    [key: string]: unknown;
  };
};

export type PushTarget = {
  alias: string;
  channel: PushChannel;
  accountKey: string;
  targetType: PushTargetType;
  providerTargetId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PublicPushTarget = Omit<PushTarget, "providerTargetId">;

export type PushJob = {
  pushId: string;
  idempotencyKey: string;
  targetAlias: string;
  status: PushJobStatus;
  payload: PushPayload;
  attemptCount: number;
  nextAttemptAt: string | null;
  providerMessageId: string | null;
  lastError: string | null;
  failureCode: PushFailureCode | null;
  claimedBy: string | null;
  claimedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
};

export type PushEgressResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; retryable: boolean; code: PushFailureCode; message: string };

export interface PushEgressPort {
  send(input: {
    pushId: string;
    target: PushTarget;
    payload: PushPayload;
    resolvedMediaPaths: string[];
  }): Promise<PushEgressResult>;
}

export type PushSourceRoutingPort = {
  resolve(input: {
    source: import("../../domain/src/vnext/models.js").SourceIdentity;
    sourceConversationId: string;
    pushId: string;
    target: PushTarget;
  }): Promise<import("../../domain/src/vnext/models.js").SourceIdentity>;
  record(input: {
    source: import("../../domain/src/vnext/models.js").SourceIdentity;
    pushId: string;
    target: PushTarget;
    providerMessageId: string;
    createdAt: string;
  }): Promise<void>;
};

export interface PushRepositoryPort {
  enqueue(input: {
    pushId: string;
    idempotencyKey: string;
    targetAlias: string;
    payload: PushPayload;
    now: string;
  }): Promise<{ job: PushJob; duplicate: boolean }>;
  get(pushId: string): Promise<PushJob | null>;
  claimNext(workerId: string, now: string): Promise<PushJob | null>;
  markDelivered(input: {
    pushId: string;
    workerId: string;
    providerMessageId: string | null;
    now: string;
  }): Promise<boolean>;
  markFailedAttempt(input: {
    pushId: string;
    workerId: string;
    code: PushFailureCode;
    error: string;
    nextAttemptAt: string | null;
    now: string;
  }): Promise<boolean>;
  recoverStaleSending(staleBefore: string, now: string): Promise<number>;
}

export interface PushTargetRegistryPort {
  getTarget(alias: string): Promise<PushTarget | null>;
  listTargets(): Promise<PublicPushTarget[]>;
  saveTarget(target: Omit<PushTarget, "createdAt" | "updatedAt">): Promise<PushTarget>;
  disableTarget(alias: string, now?: string): Promise<boolean>;
}
