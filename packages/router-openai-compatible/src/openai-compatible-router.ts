import { z } from "zod";
import type { VNextConfig } from "../../config/src/index.js";
import type {
  ConfigStorePort,
  IntentRouterInput,
  IntentRouterPort,
  RouterHealth,
  SecretStorePort
} from "../../ports/src/vnext/index.js";
import type { ControlAction, RoutingDecision } from "../../domain/src/vnext/index.js";

const threadSelectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("id"), threadId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("index"), index: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal("title"), title: z.string().min(1) }).strict()
]);

const controlActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("thread.list") }).strict(),
  z.object({ type: z.literal("thread.current") }).strict(),
  z.object({ type: z.literal("thread.switch"), target: threadSelectorSchema }).strict(),
  z.object({ type: z.literal("thread.create"), title: z.string().min(1).optional() }).strict(),
  z.object({ type: z.literal("thread.rename"), title: z.string().min(1) }).strict(),
  z.object({ type: z.literal("thread.fork"), title: z.string().min(1).optional() }).strict(),
  z.object({ type: z.literal("turn.status") }).strict(),
  z.object({ type: z.literal("turn.interrupt") }).strict(),
  z.object({ type: z.literal("model.current") }).strict(),
  z.object({ type: z.literal("model.switch"), model: z.string().min(1) }).strict(),
  z.object({ type: z.literal("quota.read") }).strict(),
  z.object({ type: z.literal("push.targets") }).strict(),
  z.object({
    type: z.literal("push.send"),
    target: z.string().min(1),
    content: z.string().min(1)
  }).strict(),
  z.object({ type: z.literal("system.status") }).strict(),
  z.object({ type: z.literal("help") }).strict()
]);

const decisionSchema = z.object({
  kind: z.enum(["chat", "control", "clarify"]),
  action: controlActionSchema.optional(),
  actions: z.array(controlActionSchema).min(1).max(5).optional(),
  confidence: z.number().min(0).max(1),
  clarification: z.string().min(1).optional()
}).strict().superRefine((decision, context) => {
  if (decision.kind === "control" && !decision.action && !decision.actions) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["action"],
      message: "Control decisions require action or actions"
    });
  }
  if (decision.action && decision.actions) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["actions"],
      message: "Control decisions must use action or actions, not both"
    });
  }
  if (decision.kind === "clarify" && !decision.clarification) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["clarification"],
      message: "Clarify decisions require a clarification"
    });
  }
});

type FetchLike = typeof fetch;

export class OpenAiCompatibleIntentRouter implements IntentRouterPort {
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly since = new Date().toISOString();
  private lastSuccessAt: string | undefined;
  private lastError: string | undefined;

  constructor(private readonly options: {
    configStore: ConfigStorePort<VNextConfig>;
    secretStore: SecretStorePort;
    fetchFn?: FetchLike;
    timeoutMs?: number;
  }) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async route(input: IntentRouterInput): Promise<RoutingDecision> {
    const router = await this.configuration();
    if (router.mode === "off") {
      throw new Error("Router is disabled");
    }
    const deterministic = deterministicDecision(input);
    if (deterministic) {
      this.lastSuccessAt = new Date().toISOString();
      this.lastError = undefined;
      return deterministic;
    }
    const secret = await this.options.secretStore.get(router.secretRef!);
    if (!secret) {
      throw new Error(`Router secret '${router.secretRef}' is unavailable`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref();
    try {
      const response = await this.fetchFn(responsesUrl(router.baseUrl!), {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: router.model,
          input: buildPrompt(input, router.highConfidenceThreshold),
          max_output_tokens: 800
        }),
        signal: controller.signal
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(`Router provider returned HTTP ${response.status}: ${providerError(payload)}`);
      }
      const decision = decisionSchema.parse(JSON.parse(extractJson(outputText(payload))));
      const actions = decision.actions ?? (decision.action ? [decision.action] : []);
      const disallowed = actions.find((action) => !input.allowedActionTypes.includes(action.type));
      if (disallowed) {
        throw new Error(`Router returned disallowed action '${disallowed.type}'`);
      }
      this.lastSuccessAt = new Date().toISOString();
      this.lastError = undefined;
      return {
        ...decision,
        ...(providerRequestId(payload, response) ? { providerRequestId: providerRequestId(payload, response) } : {})
      };
    } catch (error) {
      this.lastError = errorMessage(error);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async routeFast(
    input: Pick<IntentRouterInput, "message" | "allowedActionTypes">
  ): Promise<RoutingDecision | null> {
    const router = await this.configuration();
    if (router.mode === "off") return null;
    const decision = deterministicDecision(input);
    if (decision) {
      this.lastSuccessAt = new Date().toISOString();
      this.lastError = undefined;
    }
    return decision;
  }

  async health(): Promise<RouterHealth> {
    const router = await this.configuration();
    if (router.mode === "off") {
      return {
        component: "router",
        status: "ready",
        message: "Router is disabled",
        since: this.since
      };
    }
    const hasSecret = await this.options.secretStore.get(router.secretRef!) !== null;
    if (!hasSecret) {
      return {
        component: "router",
        status: "action_required",
        code: "ROUTER_SECRET_MISSING",
        message: `Router secret '${router.secretRef}' is unavailable`,
        since: this.since,
        suggestedAction: "Write the configured Router secret to Keychain"
      };
    }
    return {
      component: "router",
      status: this.lastError ? "degraded" : "ready",
      ...(this.lastError ? { code: "ROUTER_REQUEST_FAILED" } : {}),
      message: this.lastError ?? `Router configured for ${router.model}`,
      since: this.since,
      ...(this.lastSuccessAt ? { lastSuccessAt: this.lastSuccessAt } : {})
    };
  }

  private async configuration(): Promise<VNextConfig["router"]> {
    const snapshot = await this.options.configStore.read();
    if (!snapshot) {
      throw new Error("Router configuration is unavailable");
    }
    return snapshot.value.router;
  }
}

function buildPrompt(input: IntentRouterInput, controlThreshold: number): string {
  return [
    "You are the intent-routing skill for a Codex channel bridge. Classify the user's intent; never answer the user's question.",
    "Return exactly one JSON object and no markdown, explanation, or surrounding text.",
    `Choose kind chat, control, or clarify. Choose control only when confidence is at least ${controlThreshold}.`,
    "Use chat for content work that Codex should perform: questions, coding, research, writing, debugging, and follow-up details for an ongoing task.",
    "Use control for commands about this bridge, its Codex threads, running turns, model, quota, or health. Context fields are evidence for routing, not content to answer yourself.",
    "Use clarify only when a required target or parameter is ambiguous. Never ask the user to choose between multiple independent control requests.",
    "If one message contains multiple control intents, return kind control with an ordered actions array and include every requested action. Use action only for a single intent.",
    "Control action semantics:",
    "- thread.current: asks which/current/active thread, task, conversation, or session this channel is bound to.",
    "- thread.list: asks to list/show available or active threads.",
    "- thread.switch: asks to switch/use/open a specific existing thread; target is id, one-based index, or exact title.",
    "- thread.create: asks to create/start a new thread; optional title.",
    "- thread.rename: asks to rename the current thread; title is required.",
    "- thread.fork: asks to fork/branch the current thread; optional title.",
    "- turn.status: asks whether the current task is running, its status, or progress.",
    "- turn.interrupt: asks to stop/cancel/interrupt the running task.",
    "- model.current: asks which model is active. quota.read: asks about remaining quota. system.status: asks bridge health. help: asks what controls are supported.",
    "Critical distinction: '现在在哪个线程', '当前线程是什么', and 'which thread am I in' are thread.current, never chat.",
    "Examples:",
    "User: 现在在哪个线程 -> {\"kind\":\"control\",\"action\":{\"type\":\"thread.current\"},\"confidence\":1}",
    "User: 有哪些活动线程 -> {\"kind\":\"control\",\"action\":{\"type\":\"thread.list\"},\"confidence\":0.99}",
    "User: 切换到第2个线程 -> {\"kind\":\"control\",\"action\":{\"type\":\"thread.switch\",\"target\":{\"kind\":\"index\",\"index\":2}},\"confidence\":0.99}",
    "User: 现在哪个线程，使用什么模型 -> {\"kind\":\"control\",\"actions\":[{\"type\":\"thread.current\"},{\"type\":\"model.current\"}],\"confidence\":0.99}",
    "User: 这个 TypeScript 报错怎么修 -> {\"kind\":\"chat\",\"confidence\":0.99}",
    "For one control include action; for multiple controls include actions. For clarify, include clarification. Never invent an action outside the allowed list.",
    `Allowed action types: ${JSON.stringify(input.allowedActionTypes)}`,
    `Space: ${JSON.stringify(input.spaceDisplayName)}`,
    `Current thread: ${JSON.stringify(input.currentThreadTitle)}`,
    `Candidate threads: ${JSON.stringify(input.candidateThreads)}`,
    `Recent control messages: ${JSON.stringify(input.recentControlMessages)}`,
    `User message: ${JSON.stringify(input.message)}`,
    "JSON shape: {\"kind\":\"chat|control|clarify\",\"action\":{\"type\":\"...\"},\"actions\":[{\"type\":\"...\"}],\"confidence\":0.0,\"clarification\":\"...\"}"
  ].join("\n");
}

function deterministicDecision(
  input: Pick<IntentRouterInput, "message" | "allowedActionTypes">
): RoutingDecision | null {
  const raw = input.message.trim().toLowerCase();
  const slash = slashCommandDecision(raw, input.allowedActionTypes);
  if (slash) return slash;

  const segments = raw.split(/[，,；;。、]|以及|并且|和/)
    .map(normalizeIntentText)
    .filter(Boolean);
  const actions = segments.map(deterministicAction);
  if (actions.length === 0 || actions.some((action) => action === null)) return null;
  const unique = [...new Map((actions as ControlAction[]).map((action) => [
    JSON.stringify(action),
    action
  ])).values()];
  if (unique.some((action) => !input.allowedActionTypes.includes(action.type))) return null;
  return unique.length === 1
    ? { kind: "control", action: unique[0], confidence: 1 }
    : { kind: "control", actions: unique, confidence: 1 };
}

function deterministicAction(text: string): ControlAction | null {
  if (/^(?:我)?(?:现在|当前|目前)?(?:是)?(?:在|位于|所在|用的)?(?:哪个|哪一个|什么)(?:线程|任务|对话|会话)(?:中|里)?$/.test(text)
    || /^(?:现在|当前|目前)(?:的)?(?:线程|任务|对话|会话)(?:是|为)?(?:哪个|哪一个|什么)?(?:中|里)?$/.test(text)) {
    return { type: "thread.current" };
  }
  if (/^(?:列出|显示|查看|看看)?(?:所有|全部|可用|活动|活跃|当前)?(?:的)?(?:线程|任务|对话|会话)(?:列表)?$/.test(text)
    || /^(?:有|现在有|当前有)(?:哪些|什么)(?:可用|活动|活跃)?(?:线程|任务|对话|会话)$/.test(text)) {
    return { type: "thread.list" };
  }
  if (/^(?:当前|现在)?(?:任务|处理|执行)(?:的)?(?:状态|进度|怎么样|如何|到哪了)$/.test(text)
    || /^(?:还在|是否在|是不是在)(?:处理|执行|运行)(?:中)?$/.test(text)) {
    return { type: "turn.status" };
  }
  if (/^(?:停止|取消|中断|终止)(?:当前|现在|正在)?(?:任务|处理|执行|操作)?$/.test(text)) {
    return { type: "turn.interrupt" };
  }
  if (/^(?:现在|当前)?(?:使用的|用的|正在使用的)?(?:什么|哪个|哪一个)模型$/.test(text)
    || /^(?:现在|当前)?模型(?:是|为)?(?:什么|哪个|哪一个)?$/.test(text)) {
    return { type: "model.current" };
  }
  if (/^(?:帮助|help|你支持什么控制|有哪些控制命令)$/.test(text)) {
    return { type: "help" };
  }
  return null;
}

function slashCommandDecision(raw: string, allowed: string[]): RoutingDecision | null {
  if (!raw.startsWith("/")) return null;
  const single = (action: ControlAction): RoutingDecision => allowed.includes(action.type)
    ? { kind: "control", action, confidence: 1 }
    : { kind: "clarify", confidence: 1, clarification: `当前渠道不支持指令 ${raw}` };
  if (raw === "/h" || raw === "/help") return single({ type: "help" });
  if (raw === "/t" || raw === "/threads" || raw === "/thread list") return single({ type: "thread.list" });
  if (raw === "/tc" || raw === "/thread current") return single({ type: "thread.current" });
  if (raw === "/m" || raw === "/model") return single({ type: "model.current" });
  if (raw === "/q" || raw === "/quota") return single({ type: "quota.read" });
  if (raw === "/st" || raw === "/status") {
    const statusActions: ControlAction[] = [
      { type: "thread.current" },
      { type: "model.current" },
      { type: "quota.read" },
      { type: "system.status" }
    ];
    const actions = statusActions.filter((action) => allowed.includes(action.type));
    return { kind: "control", actions, confidence: 1 };
  }
  const create = raw.match(/^(?:\/tn|\/thread\s+new)\s+(.+)$/);
  if (create) return single({ type: "thread.create", title: create[1]!.trim() });
  if (raw === "/tn" || raw === "/thread new") {
    return { kind: "clarify", confidence: 1, clarification: "用法：`/tn <新线程标题>`" };
  }
  const use = raw.match(/^(?:\/tu|\/thread\s+use)\s+(\d+)$/);
  if (use) return single({ type: "thread.switch", target: { kind: "index", index: Number(use[1]) } });
  const fork = raw.match(/^(?:\/tf|\/thread\s+fork)\s+(.+)$/);
  if (fork) return single({ type: "thread.fork", title: fork[1]!.trim() });
  const model = raw.match(/^(?:\/mu|\/model\s+use)\s+(.+)$/);
  if (model) return single({ type: "model.switch", model: model[1]!.trim() });
  return {
    kind: "clarify",
    confidence: 1,
    clarification: `未识别的桥接指令：\`${raw}\`。发送 \`/h\` 查看可用命令。`
  };
}

function normalizeIntentText(value: string): string {
  return value.replace(/[！？.!?\s]/g, "");
}

function responsesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/responses`;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > 1024 * 1024) {
    throw new Error("Router provider response exceeded 1 MiB");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Router provider returned invalid JSON");
  }
}

function outputText(payload: unknown): string {
  if (!isRecord(payload)) throw new Error("Router provider response is invalid");
  if (typeof payload.output_text === "string") return payload.output_text;
  if (Array.isArray(payload.output)) {
    const parts = payload.output.flatMap((item) => {
      if (!isRecord(item) || !Array.isArray(item.content)) return [];
      return item.content.flatMap((content) => isRecord(content) && typeof content.text === "string"
        ? [content.text]
        : []);
    });
    if (parts.length > 0) return parts.join("");
  }
  throw new Error("Router provider response did not contain output text");
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Router output did not contain a JSON object");
  return unfenced.slice(start, end + 1);
}

function providerRequestId(payload: unknown, response: Response): string | undefined {
  if (isRecord(payload) && typeof payload.id === "string" && payload.id) return payload.id;
  return response.headers.get("x-request-id") ?? undefined;
}

function providerError(payload: unknown): string {
  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string") {
    return payload.error.message;
  }
  return "request failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
