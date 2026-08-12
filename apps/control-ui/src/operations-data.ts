import { controlApi } from "./api-client.js";

export type Page<T> = { items: T[]; nextCursor: string | null };

export type SpaceItem = {
  spaceId: string;
  channel: "weixin" | "feishu" | "qq";
  displayName: string;
  scope: "c2c" | "group";
  status: string;
  lastInboundAt: string | null;
  binding: null | {
    bindingId: string;
    threadId: string;
    threadTitle: string;
    mode: "exclusive" | "shared";
    status: string;
  };
};

export type ThreadItem = {
  threadId: string;
  title: string;
  projectName: string | null;
  updatedAt: string | null;
};

export type TurnItem = {
  turnId: string;
  threadId: string;
  spaceId: string;
  status: string;
  transport: string;
  errorCode: string | null;
  queuedAt: string;
  completedAt: string | null;
};

export type RouterConfig = {
  mode: "off" | "assist" | "auto";
  adapter: "openai-compatible";
  baseUrl: string | null;
  model: string | null;
  secretRef: string | null;
  highConfidenceThreshold: number;
  clarifyThreshold: number;
};

export type RouterDecision = {
  decisionId: string;
  decision: { kind: string; confidence: number; clarification?: string };
  latencyMs: number;
  result: string | null;
  createdAt: string;
};

export type VNextConfig = {
  version: 1;
  runtime: { listenHost: string; listenPort: number; maxParallelThreads: number };
  codex: { transport: "app-server"; recoveryTransport: "cdp" };
  router: RouterConfig;
  channels: unknown[];
  push: { enabled: boolean; outboxRoot: string; maxRequestsPerMinute: number };
  queues: { spaceLimit: number; threadLimit: number; progressDelayMs: number };
};

export type ConfigSnapshot = { value: VNextConfig; revision: string };
export type ApplyPlan = {
  revision: string;
  effects: Array<{ type: string; component?: string }>;
};

export type DiagnosticEvent = {
  eventId: string;
  component: string;
  type: string;
  occurredAt: string;
};

export async function loadSpaces(): Promise<{ spaces: SpaceItem[]; threads: ThreadItem[] }> {
  const [spaces, threads] = await Promise.all([
    controlApi.get<unknown>("/spaces?limit=100"),
    controlApi.get<unknown>("/threads?limit=100")
  ]);
  return {
    spaces: pageItems(spaces, "spaces") as SpaceItem[],
    threads: pageItems(threads, "threads") as ThreadItem[]
  };
}

export function bindSpace(spaceId: string, threadId: string, mode: "exclusive" | "shared"): Promise<unknown> {
  return controlApi.post(`/spaces/${encodeURIComponent(spaceId)}/bindings`, {
    threadId,
    mode,
    replaceActive: true
  });
}

export function unbindSpace(spaceId: string): Promise<unknown> {
  return controlApi.delete(`/spaces/${encodeURIComponent(spaceId)}/bindings/current`);
}

export async function loadTasks(): Promise<{ threads: ThreadItem[]; turns: TurnItem[] }> {
  const [threads, turns] = await Promise.all([
    controlApi.get<unknown>("/threads?limit=100"),
    controlApi.get<unknown>("/turns?limit=100")
  ]);
  return {
    threads: pageItems(threads, "threads") as ThreadItem[],
    turns: pageItems(turns, "turns") as TurnItem[]
  };
}

export function createThread(input: { title?: string; cwd?: string }): Promise<ThreadItem> {
  return controlApi.post("/threads", input);
}

export function interruptTurn(turnId: string): Promise<unknown> {
  return controlApi.post(`/turns/${encodeURIComponent(turnId)}/interrupt`, {});
}

export async function loadRouter(): Promise<{ config: RouterConfig; decisions: RouterDecision[] }> {
  const [config, decisions] = await Promise.all([
    controlApi.get<RouterConfig>("/router/config"),
    controlApi.get<unknown>("/router/decisions?limit=20")
  ]);
  return { config, decisions: pageItems(decisions, "router decisions") as RouterDecision[] };
}

export function updateRouter(config: RouterConfig): Promise<unknown> {
  return controlApi.put("/router/config", config);
}

export function testRouter(text: string): Promise<unknown> {
  return controlApi.post("/router/test", { text });
}

export async function loadSettings(): Promise<{ config: ConfigSnapshot; events: DiagnosticEvent[] }> {
  const [config, events] = await Promise.all([
    controlApi.get<ConfigSnapshot>("/config"),
    loadDiagnostics()
  ]);
  return { config, events };
}

export async function planAndApplyConfig(candidate: VNextConfig): Promise<ApplyPlan> {
  const plan = await controlApi.post<ApplyPlan>("/config/plan", { candidate });
  const applied = await controlApi.post<ApplyPlan>("/config/apply", { candidate, secretChanges: [] });
  if (applied.revision !== plan.revision) {
    throw new Error("配置应用返回了不一致的 Revision");
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = await controlApi.get<{ activeRevision: string | null }>("/system/status");
    if (status.activeRevision === plan.revision) {
      return plan;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  throw new Error(`配置 ${plan.revision} 尚未成为 Active Revision`);
}

export async function loadDiagnostics(): Promise<DiagnosticEvent[]> {
  return pageItems(await controlApi.get<unknown>("/diagnostics/events?limit=100"), "diagnostics events") as DiagnosticEvent[];
}

export function exportDiagnostics(includeLogs: boolean): Promise<{ path: string; createdAt: string }> {
  return controlApi.post("/diagnostics/export", { includeLogs });
}

function pageItems(value: unknown, field: string): unknown[] {
  const record = asRecord(value, field);
  if (!Array.isArray(record.items)) {
    throw new Error(`${field}.items must be an array`);
  }
  return record.items;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}
