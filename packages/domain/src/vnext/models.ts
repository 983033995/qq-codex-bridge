import type {
  ChannelAccountId,
  ChannelName,
  ConversationScope,
  ConversationSpaceId
} from "./identifiers.js";
import type { StableErrorCode } from "./errors.js";

export type ChannelAccount = {
  accountId: ChannelAccountId;
  channel: ChannelName;
  displayName: string;
  status: "active" | "disabled" | "action_required";
};

export type ConversationSpace = {
  spaceId: ConversationSpaceId;
  channel: ChannelName;
  accountId: ChannelAccountId;
  providerConversationId: string;
  scope: ConversationScope;
  displayName: string;
  status: "active" | "paused" | "unavailable";
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
};

export type CodexThread = {
  threadId: string;
  title: string;
  projectName: string | null;
  updatedAt: string | null;
};

export type ThreadBindingMode = "exclusive" | "shared";
export type ThreadBindingStatus = "active" | "detached" | "broken";

export type ThreadBinding = {
  bindingId: string;
  spaceId: ConversationSpaceId;
  threadId: string;
  threadTitle: string;
  mode: ThreadBindingMode;
  status: ThreadBindingStatus;
  createdAt: string;
  updatedAt: string;
};

export type Mention = {
  providerUserId: string;
  displayName?: string;
  offset?: number;
  length?: number;
};

export type Attachment = {
  id: string;
  kind: "image" | "audio" | "video" | "file";
  localPath: string;
  mimeType: string;
  size: number;
  name?: string;
  transcript?: string;
};

export type MessageContent = {
  text: string;
  mentions: Mention[];
  attachments: Attachment[];
  format?: "plain" | "markdown";
};

export type InboundEnvelope = {
  messageId: string;
  providerMessageId: string;
  spaceId: ConversationSpaceId;
  senderId: string;
  receivedSequence: number;
  receivedAt: string;
  content: MessageContent;
};

export type TurnStatus =
  | "queued"
  | "starting"
  | "running"
  | "unknown"
  | "completed"
  | "failed"
  | "interrupted";

export type TurnTransport = "app-server" | "cdp-recovery";

export type Turn = {
  turnId: string;
  threadId: string;
  spaceId: ConversationSpaceId;
  inboundMessageId: string;
  status: TurnStatus;
  transport: TurnTransport;
  errorCode: StableErrorCode | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type DeliveryStatus = "pending" | "sending" | "retry_wait" | "delivered" | "failed";

export type Delivery = {
  deliveryId: string;
  deliveryKey: string;
  spaceId: ConversationSpaceId;
  status: DeliveryStatus;
  providerMessageId: string | null;
  attempts: number;
  errorCode: StableErrorCode | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ThreadSelector =
  | { kind: "id"; threadId: string }
  | { kind: "index"; index: number }
  | { kind: "title"; title: string };

export type ControlAction =
  | { type: "thread.list" }
  | { type: "thread.current" }
  | { type: "thread.switch"; target: ThreadSelector }
  | { type: "thread.create"; title?: string }
  | { type: "thread.rename"; title: string }
  | { type: "thread.fork"; title?: string }
  | { type: "turn.status" }
  | { type: "turn.interrupt" }
  | { type: "model.current" }
  | { type: "model.switch"; model: string }
  | { type: "quota.read" }
  | { type: "push.targets" }
  | { type: "push.send"; target: string; content: string }
  | { type: "system.status" }
  | { type: "help" };

export type RoutingDecision = {
  kind: "chat" | "control" | "clarify";
  action?: ControlAction;
  actions?: ControlAction[];
  confidence: number;
  clarification?: string;
  providerRequestId?: string;
};

export type ComponentHealth = {
  component: string;
  status: "ready" | "degraded" | "action_required" | "offline";
  code?: string;
  message: string;
  since: string;
  lastSuccessAt?: string;
  suggestedAction?: string;
};
