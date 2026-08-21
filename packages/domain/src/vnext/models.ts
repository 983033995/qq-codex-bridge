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

export type SourceCapability = "interactive" | "push_only" | "system";

export type SourceIdentity = {
  provider: string;
  instanceId?: string;
  conversationId?: string;
  conversationAlias?: string;
  projectId?: string;
  projectName?: string;
  taskId?: string;
  taskTitle?: string;
  capability: SourceCapability;
};

export type ConversationAlias = {
  alias: string;
  provider: string;
  instanceId: string | null;
  sourceConversationId: string;
  projectId: string | null;
  projectName: string | null;
  taskId: string | null;
  taskTitle: string | null;
  capability: SourceCapability;
  createdAt: string;
  updatedAt: string;
};

export type ChannelMessageDirection = "inbound" | "outbound" | "system";

export type ChannelMessageRegistryEntry = {
  registryId: string;
  channel: ChannelName;
  channelAccountId: ChannelAccountId;
  peerId: string;
  channelMessageId: string;
  gatewayMessageId: string;
  provider: string;
  sourceConversationId: string | null;
  sourceAlias: string | null;
  taskId: string | null;
  capability: SourceCapability;
  direction: ChannelMessageDirection;
  createdAt: string;
};

export type ActiveConversationUpdatedBy = "explicit_switch" | "reply_reference" | "admin";

export type ActiveConversation = {
  channel: ChannelName;
  channelAccountId: ChannelAccountId;
  peerId: string;
  conversationAlias: string;
  sourceConversationId: string;
  updatedBy: ActiveConversationUpdatedBy;
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
  replyToProviderMessageId?: string;
  source?: SourceIdentity;
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

export type TurnResultCheckpoint = {
  finalText: string;
  mediaReferences: string[];
  source?: SourceIdentity;
};

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
  result?: TurnResultCheckpoint;
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

export type ConversationAction =
  | { type: "conversation.list" }
  | { type: "conversation.current" }
  | { type: "conversation.switch"; alias: string };

export type RouterMode = "off" | "assist" | "auto";
export type RouterRisk = "read" | "low" | "medium" | "high";

export type RouterAction =
  | ControlAction
  | ConversationAction
  | { type: "channel.restart"; channel: "qq" | "weixin" | "feishu" }
  | { type: "setup.channel.connect"; channel: "qq" | "weixin" | "feishu"; accountId?: string }
  | { type: "setup.channel.login"; channel: "qq" | "weixin" | "feishu"; accountId?: string }
  | { type: "approval.resolve"; resolution: "approve" | "decline" };

export type RoutingDecision = {
  kind: "conversation" | "control" | "setup" | "approval" | "unknown";
  action?: RouterAction;
  actions?: RouterAction[];
  confidence: number;
  risk: RouterRisk;
  mode: RouterMode;
  clarification?: string;
  providerRequestId?: string;
  fallbackReason?: string;
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
