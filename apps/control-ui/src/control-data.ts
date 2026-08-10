import { controlApi } from "./api-client.js";

export type HealthStatus = "ready" | "degraded" | "action_required" | "offline";

export type ComponentHealth = {
  component: string;
  status: HealthStatus;
  message: string;
  since: string;
  code?: string;
  lastSuccessAt?: string;
  suggestedAction?: string;
};

export type HealthReport = {
  status: HealthStatus;
  checkedAt: string;
  components: ComponentHealth[];
};

export type SystemStatus = {
  state: string;
  activeRevision: string | null;
  version: string | null;
};

export type ChannelSummary = {
  id: string;
  channel: "weixin" | "feishu" | "qq";
  accountId: string;
  displayName: string;
  enabled: boolean;
  status: HealthStatus;
  message: string;
  lastActivityAt: string | null;
  suggestedAction?: string;
};

export type ActivitySummary = {
  eventId: string;
  component: string;
  type: string;
  occurredAt: string;
};

export type OverviewData = {
  health: HealthReport;
  system: SystemStatus;
  channels: ChannelSummary[];
  activities: ActivitySummary[];
};

export type ChannelCreateInput =
  | { channel: "weixin"; accountId: string; enabled: boolean }
  | { channel: "feishu" | "qq"; accountId: string; enabled: boolean; appId: string; secretRef: string };

export type ControlClient = Pick<typeof controlApi, "get" | "post" | "delete">;

export async function loadOverview(client: ControlClient = controlApi): Promise<OverviewData> {
  const [health, system, channels, activities] = await Promise.all([
    client.get<unknown>("/health"),
    client.get<unknown>("/system/status"),
    client.get<unknown>("/channels"),
    client.get<unknown>("/diagnostics/events?limit=5")
  ]);
  return {
    health: parseHealthReport(health),
    system: parseSystemStatus(system),
    channels: parseChannels(channels),
    activities: parseActivities(activities).slice(0, 5)
  };
}

export async function loadChannels(client: ControlClient = controlApi): Promise<ChannelSummary[]> {
  return parseChannels(await client.get<unknown>("/channels"));
}

export async function createChannel(input: ChannelCreateInput, client: ControlClient = controlApi): Promise<void> {
  await client.post("/channels", input);
}

export async function testChannel(id: string, client: ControlClient = controlApi): Promise<void> {
  await client.post(`/channels/${encodeURIComponent(required(id, "channel id"))}/test`, {});
}

export async function restartChannel(id: string, client: ControlClient = controlApi): Promise<void> {
  await client.post(`/channels/${encodeURIComponent(required(id, "channel id"))}/restart`, {});
}

export async function deleteChannel(id: string, client: ControlClient = controlApi): Promise<void> {
  await client.delete(`/channels/${encodeURIComponent(required(id, "channel id"))}`);
}

export function statusLabel(status: HealthStatus): string {
  return {
    ready: "运行正常",
    degraded: "降级运行",
    action_required: "需要操作",
    offline: "离线"
  }[status];
}

export function channelLabel(channel: ChannelSummary["channel"]): string {
  return { weixin: "微信", feishu: "飞书", qq: "QQ" }[channel];
}

function parseHealthReport(value: unknown): HealthReport {
  const record = requiredRecord(value, "health");
  const components = requiredArray(record.components, "health.components").map((item, index) => {
    const component = requiredRecord(item, `health.components[${index}]`);
    return {
      component: requiredString(component.component, `health.components[${index}].component`),
      status: parseHealthStatus(component.status, `health.components[${index}].status`),
      message: requiredString(component.message, `health.components[${index}].message`),
      since: requiredIsoDate(component.since, `health.components[${index}].since`),
      ...optionalStringFields(component, ["code", "lastSuccessAt", "suggestedAction"])
    };
  });
  return {
    status: parseHealthStatus(record.status, "health.status"),
    checkedAt: requiredIsoDate(record.checkedAt, "health.checkedAt"),
    components
  };
}

function parseSystemStatus(value: unknown): SystemStatus {
  const record = requiredRecord(value, "system status");
  return {
    state: requiredString(record.state ?? record.daemonState ?? record.status, "system.state"),
    activeRevision: optionalString(record.activeRevision),
    version: optionalString(record.version)
  };
}

function parseChannels(value: unknown): ChannelSummary[] {
  return listItems(value, "channels").map((item, index) => {
    const record = requiredRecord(item, `channels[${index}]`);
    const channel = parseChannel(record.channel, `channels[${index}].channel`);
    const accountId = requiredString(record.accountId, `channels[${index}].accountId`);
    const rawStatus = requiredString(record.status, `channels[${index}].status`);
    const status = parseChannelStatus(rawStatus, `channels[${index}].status`);
    return {
      id: optionalString(record.id) ?? optionalString(record.accountKey) ?? `${channel}:${accountId}`,
      channel,
      accountId,
      displayName: optionalString(record.displayName) ?? `${channelLabel(channel)} · ${accountId}`,
      enabled: typeof record.enabled === "boolean" ? record.enabled : rawStatus !== "disabled",
      status,
      message: optionalString(record.message) ?? statusLabel(status),
      lastActivityAt: optionalIsoDate(record.lastActivityAt ?? record.lastSuccessAt ?? record.updatedAt),
      ...(optionalString(record.suggestedAction)
        ? { suggestedAction: optionalString(record.suggestedAction)! }
        : {})
    };
  });
}

function parseActivities(value: unknown): ActivitySummary[] {
  return listItems(value, "diagnostics events").map((item, index) => {
    const record = requiredRecord(item, `events[${index}]`);
    return {
      eventId: requiredString(record.eventId, `events[${index}].eventId`),
      component: requiredString(record.component, `events[${index}].component`),
      type: requiredString(record.type, `events[${index}].type`),
      occurredAt: requiredIsoDate(record.occurredAt, `events[${index}].occurredAt`)
    };
  });
}

function listItems(value: unknown, field: string): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  const record = requiredRecord(value, field);
  return requiredArray(record.items, `${field}.items`);
}

function parseHealthStatus(value: unknown, field: string): HealthStatus {
  if (value === "ready" || value === "degraded" || value === "action_required" || value === "offline") {
    return value;
  }
  throw new Error(`${field} is invalid`);
}

function parseChannelStatus(value: string, field: string): HealthStatus {
  if (value === "active") {
    return "ready";
  }
  if (value === "disabled") {
    return "offline";
  }
  return parseHealthStatus(value, field);
}

function parseChannel(value: unknown, field: string): ChannelSummary["channel"] {
  if (value === "weixin" || value === "feishu" || value === "qq") {
    return value;
  }
  throw new Error(`${field} is invalid`);
}

function optionalStringFields(record: Record<string, unknown>, fields: readonly string[]): Record<string, string> {
  return Object.fromEntries(fields.flatMap((field) => {
    const value = optionalString(record[field]);
    return value ? [[field, value]] : [];
  }));
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  return required(typeof value === "string" ? value : "", field);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredIsoDate(value: unknown, field: string): string {
  const normalized = requiredString(value, field);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new Error(`${field} must be an ISO date`);
  }
  return normalized;
}

function optionalIsoDate(value: unknown): string | null {
  const normalized = optionalString(value);
  return normalized && Number.isFinite(Date.parse(normalized)) ? normalized : null;
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}
