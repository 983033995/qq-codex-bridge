import { z } from "zod";
import type { VNextConfig } from "../../config/src/index.js";
import type {
  ConfigStorePort,
  IntentRouterInput,
  IntentRouterPort,
  RouterHealth,
  SecretStorePort
} from "../../ports/src/vnext/index.js";
import type { ControlAction, ConversationAction, RouterAction, RoutingDecision } from "../../domain/src/vnext/index.js";

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

const conversationActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("conversation.list") }).strict(),
  z.object({ type: z.literal("conversation.current") }).strict(),
  z.object({ type: z.literal("conversation.switch"), alias: z.string().min(1) }).strict()
]);

const channelSchema = z.enum(["qq", "weixin", "feishu"]);
const routerActionSchema = z.discriminatedUnion("type", [
  ...controlActionSchema.options,
  ...conversationActionSchema.options,
  z.object({ type: z.literal("channel.restart"), channel: channelSchema }).strict(),
  z.object({ type: z.literal("setup.channel.connect"), channel: channelSchema, accountId: z.string().min(1).optional() }).strict(),
  z.object({ type: z.literal("setup.channel.login"), channel: channelSchema, accountId: z.string().min(1).optional() }).strict(),
  z.object({ type: z.literal("approval.resolve"), resolution: z.enum(["approve", "decline"]) }).strict()
]);

const decisionSchema = z.object({
  kind: z.enum(["conversation", "control", "setup", "approval", "unknown"]),
  action: routerActionSchema.optional(),
  actions: z.array(routerActionSchema).min(1).max(5).optional(),
  confidence: z.number().min(0).max(1),
  risk: z.enum(["read", "low", "medium", "high"]),
  clarification: z.string().min(1).optional()
}).strict().superRefine((decision, context) => {
  if (["control", "setup", "approval"].includes(decision.kind) && !decision.action && !decision.actions) {
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
  if (decision.kind === "unknown" && !decision.clarification) {
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
    const deterministic = deterministicDecision(input, router.mode, false);
    if (deterministic) {
      this.lastSuccessAt = new Date().toISOString();
      this.lastError = undefined;
      return deterministic;
    }
    if (router.mode === "off") {
      return conversationDecision("off", "router_off");
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
      const parsed = decisionSchema.parse(JSON.parse(extractJson(outputText(payload))));
      const decision = applyConfidencePolicy(parsed, router);
      const actions = decision.actions ?? (decision.action ? [decision.action] : []);
      const disallowed = actions.find((action) => !input.allowedActionTypes.includes(action.type));
      if (disallowed) {
        throw new Error(`Router returned disallowed action '${disallowed.type}'`);
      }
      this.lastSuccessAt = new Date().toISOString();
      this.lastError = undefined;
      return {
        ...decision,
        mode: router.mode,
        ...(providerRequestId(payload, response) ? { providerRequestId: providerRequestId(payload, response) } : {})
      };
    } catch (error) {
      this.lastError = errorMessage(error);
      return conversationDecision(router.mode, this.lastError);
    } finally {
      clearTimeout(timeout);
    }
  }

  async routeFast(
    input: Pick<IntentRouterInput, "message" | "allowedActionTypes">
  ): Promise<RoutingDecision | null> {
    const router = await this.configuration();
    const decision = deterministicDecision(input, router.mode, true);
    if (decision) {
      this.lastSuccessAt = new Date().toISOString();
      this.lastError = undefined;
    }
    return decision ?? (router.mode === "off" ? conversationDecision("off", "router_off") : null);
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
    "You are the inbound intent router for OmniAgent Gateway. Classify the user's intent; never answer the user's question.",
    "Return exactly one JSON object and no markdown, explanation, or surrounding text.",
    `Choose kind conversation, control, setup, approval, or unknown. Choose a side-effect kind only when confidence is at least ${controlThreshold}.`,
    "Use conversation for coding, research, writing, debugging, questions, and content mentioning channel code.",
    "Use control for Gateway/Runtime/channel/thread control. Use setup for connecting or re-login. Use approval for approve/decline intent.",
    "Use unknown with clarification when a required target or action is ambiguous.",
    "If one message contains multiple control intents, return kind control with an ordered actions array and include every requested action. Use action only for a single intent.",
    "Control action semantics:",
    "- thread.current: asks which/current/active thread, task, conversation, or session this channel is bound to.",
    "- thread.list: asks to list/show available or active threads.",
    "- thread.switch: asks to switch/use/open a specific existing thread; target is id, one-based index, or exact title.",
    "- thread.create: asks to create/start a new thread; optional title.",
    "- thread.rename: asks to rename the current thread; title is required.",
    "- thread.fork: asks to fork/branch the current thread; optional title.",
    "- conversation.list: asks to list recent source conversations or sessions.",
    "- conversation.current: asks which source conversation is currently active in this channel.",
    "- conversation.switch: asks to switch to a source alias; alias must be copied from candidate conversations and never invented.",
    "- turn.status: asks whether the current task is running, its status, or progress.",
    "- turn.interrupt: asks to stop/cancel/interrupt the running task.",
    "- model.current: asks which model is active. quota.read: asks about remaining quota. system.status: asks bridge health. help: asks what controls are supported.",
    "- channel.restart: restart one configured channel; include channel.",
    "- setup.channel.connect/setup.channel.login: connect or login a channel; include channel.",
    "- approval.resolve: approve or decline a pending approval.",
    "Critical distinction: '现在在哪个线程', '当前线程是什么', and 'which thread am I in' are thread.current, never chat.",
    "Examples:",
    "User: 现在在哪个线程 -> {\"kind\":\"control\",\"action\":{\"type\":\"thread.current\"},\"confidence\":1}",
    "User: 有哪些活动线程 -> {\"kind\":\"control\",\"action\":{\"type\":\"thread.list\"},\"confidence\":0.99}",
    "User: 切换到第2个线程 -> {\"kind\":\"control\",\"action\":{\"type\":\"thread.switch\",\"target\":{\"kind\":\"index\",\"index\":2}},\"confidence\":0.99}",
    "User: 切到 #C9P1 -> {\"kind\":\"control\",\"action\":{\"type\":\"conversation.switch\",\"alias\":\"#C9P1\"},\"confidence\":1,\"risk\":\"low\"}",
    "User: 当前我在跟哪个线程说话？ -> {\"kind\":\"control\",\"action\":{\"type\":\"conversation.current\"},\"confidence\":1,\"risk\":\"read\"}",
    "User: 切到 PageMind 那个任务 -> select the matching alias from Candidate conversations and return conversation.switch.",
    "User: 现在哪个线程，使用什么模型 -> {\"kind\":\"control\",\"actions\":[{\"type\":\"thread.current\"},{\"type\":\"model.current\"}],\"confidence\":0.99}",
    "User: 重启微信 -> {\"kind\":\"control\",\"action\":{\"type\":\"channel.restart\",\"channel\":\"weixin\"},\"confidence\":0.98,\"risk\":\"medium\"}",
    "User: 重新登录微信 -> {\"kind\":\"setup\",\"action\":{\"type\":\"setup.channel.login\",\"channel\":\"weixin\"},\"confidence\":0.98,\"risk\":\"medium\"}",
    "User: 允许刚才的命令 -> {\"kind\":\"approval\",\"action\":{\"type\":\"approval.resolve\",\"resolution\":\"approve\"},\"confidence\":0.98,\"risk\":\"high\"}",
    "User: 这个微信 TypeScript 报错怎么修 -> {\"kind\":\"conversation\",\"confidence\":0.99,\"risk\":\"read\"}",
    "Every result must include risk. Never invent an action outside the allowed list.",
    `Allowed action types: ${JSON.stringify(input.allowedActionTypes)}`,
    `Space: ${JSON.stringify(input.spaceDisplayName)}`,
    `Current thread: ${JSON.stringify(input.currentThreadTitle)}`,
    `Candidate threads: ${JSON.stringify(input.candidateThreads)}`,
    `Candidate conversations: ${JSON.stringify(input.candidateConversations ?? [])}`,
    `Recent control messages: ${JSON.stringify(input.recentControlMessages)}`,
    `User message: ${JSON.stringify(input.message)}`,
    "JSON shape: {\"kind\":\"conversation|control|setup|approval|unknown\",\"action\":{\"type\":\"...\"},\"actions\":[{\"type\":\"...\"}],\"confidence\":0.0,\"risk\":\"read|low|medium|high\",\"clarification\":\"...\"}"
  ].join("\n");
}

function deterministicDecision(
  input: Pick<IntentRouterInput, "message" | "allowedActionTypes">,
  mode: RoutingDecision["mode"],
  _fastOnly: boolean
): RoutingDecision | null {
  const raw = input.message.trim().toLowerCase();
  const slash = slashCommandDecision(raw, input.allowedActionTypes, mode);
  if (slash) return slash;
  if (mode === "off") return null;

  const segments = raw.split(/[，,；;。、]|以及|并且|和/)
    .map(normalizeIntentText)
    .filter(Boolean);
  const actions = segments.map(deterministicAction);
  if (actions.length === 0 || actions.some((action) => action === null)) return null;
  const unique = [...new Map((actions as RouterAction[]).map((action) => [
    JSON.stringify(action),
    action
  ])).values()];
  if (unique.some((action) => !input.allowedActionTypes.includes(action.type))) return null;
  return unique.length === 1
    ? routerActionDecision(unique[0]!, mode)
    : { kind: "control", actions: unique, confidence: 1, risk: actionRisk(unique), mode };
}

function routerActionDecision(action: RouterAction, mode: RoutingDecision["mode"]): RoutingDecision {
  if (action.type === "approval.resolve") return approvalDecision(action.resolution, mode);
  return { kind: "control", action, confidence: 1, risk: actionRisk([action]), mode };
}

function deterministicAction(text: string): RouterAction | null {
  const aliasSwitch = /^(?:切到|切换到|回到|使用|用)(?:会话|对话|线程|任务)?\s*(#[a-z][a-z0-9]{2,4})$/.exec(text);
  if (aliasSwitch) {
    return {
      type: "conversation.switch",
      alias: aliasSwitch[1]!.toUpperCase()
    };
  }
  if (/^(?:当前我在跟|我现在在跟|当前正在跟)(?:哪个|哪一个|什么)(?:线程|任务|对话|会话)(?:说话|沟通)?$/.test(text)) {
    return { type: "conversation.current" };
  }
  if (/^(?:列出|显示|查看|看看)?(?:所有|全部|可用|最近)?(?:的)?(?:会话|对话)(?:列表)?$/.test(text)) {
    return { type: "conversation.list" };
  }
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

function slashCommandDecision(raw: string, allowed: string[], mode: RoutingDecision["mode"]): RoutingDecision | null {
  if (!raw.startsWith("/")) return null;
  const single = (action: ControlAction): RoutingDecision => allowed.includes(action.type)
    ? controlDecision(action, mode)
    : unknownDecision(mode, `当前渠道不支持指令 ${raw}`);
  if (raw === "/approve") return approvalDecision("approve", mode);
  if (raw === "/decline") return approvalDecision("decline", mode);
  if (raw === "/h" || raw === "/help") return single({ type: "help" });
  if (raw === "/sessions") return singleConversation({ type: "conversation.list" }, allowed, mode);
  if (raw === "/current") return singleConversation({ type: "conversation.current" }, allowed, mode);
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
    return { kind: "control", actions, confidence: 1, risk: actionRisk(actions), mode };
  }
  const create = raw.match(/^(?:\/tn|\/thread\s+new)\s+(.+)$/);
  if (create) return single({ type: "thread.create", title: create[1]!.trim() });
  if (raw === "/tn" || raw === "/thread new") {
    return unknownDecision(mode, "用法：`/tn <新线程标题>`");
  }
  const use = raw.match(/^(?:\/tu|\/thread\s+use)\s+(\d+)$/);
  if (use) return single({ type: "thread.switch", target: { kind: "index", index: Number(use[1]) } });
  const conversationUse = raw.match(/^\/use\s+(#?[a-z][a-z0-9]{2,4})$/i);
  if (conversationUse) {
    const rawAlias = conversationUse[1]!.toUpperCase();
    const alias = rawAlias.startsWith("#") ? rawAlias : `#${rawAlias}`;
    return singleConversation({ type: "conversation.switch", alias }, allowed, mode);
  }
  const fork = raw.match(/^(?:\/tf|\/thread\s+fork)\s+(.+)$/);
  if (fork) return single({ type: "thread.fork", title: fork[1]!.trim() });
  const model = raw.match(/^(?:\/mu|\/model\s+use)\s+(.+)$/);
  if (model) return single({ type: "model.switch", model: model[1]!.trim() });
  return {
    kind: "unknown",
    confidence: 1,
    risk: "read",
    mode,
    clarification: `未识别的桥接指令：\`${raw}\`。发送 \`/h\` 查看可用命令。`
  };
}

function singleConversation(
  action: ConversationAction,
  allowed: string[],
  mode: RoutingDecision["mode"]
): RoutingDecision {
  return allowed.includes(action.type)
    ? { kind: "control", action, confidence: 1, risk: action.type === "conversation.switch" ? "low" : "read", mode }
    : unknownDecision(mode, `当前渠道不支持指令 ${action.type}`);
}

function applyConfidencePolicy(
  decision: z.infer<typeof decisionSchema>,
  config: VNextConfig["router"]
): Omit<RoutingDecision, "mode"> {
  if (["control", "setup", "approval"].includes(decision.kind)) {
    if (decision.confidence < config.clarifyThreshold) {
      return { kind: "conversation", confidence: decision.confidence, risk: "read", fallbackReason: "low_confidence" };
    }
    if (decision.confidence < config.highConfidenceThreshold) {
      return {
        kind: "unknown",
        confidence: decision.confidence,
        risk: decision.risk,
        clarification: decision.clarification ?? "请再具体说明你想执行的操作。"
      };
    }
  }
  return decision;
}

function controlDecision(action: ControlAction, mode: RoutingDecision["mode"]): RoutingDecision {
  return { kind: "control", action, confidence: 1, risk: actionRisk([action]), mode };
}

function approvalDecision(resolution: "approve" | "decline", mode: RoutingDecision["mode"]): RoutingDecision {
  return { kind: "approval", action: { type: "approval.resolve", resolution }, confidence: 1, risk: "high", mode };
}

function unknownDecision(mode: RoutingDecision["mode"], clarification: string): RoutingDecision {
  return { kind: "unknown", confidence: 1, risk: "read", mode, clarification };
}

function conversationDecision(mode: RoutingDecision["mode"], fallbackReason?: string): RoutingDecision {
  return { kind: "conversation", confidence: 1, risk: "read", mode, ...(fallbackReason ? { fallbackReason } : {}) };
}

function actionRisk(actions: readonly RouterAction[]): RoutingDecision["risk"] {
  if (actions.some((action) => action.type === "approval.resolve")) return "high";
  if (actions.some((action) => action.type === "channel.restart" || action.type.startsWith("setup."))) return "medium";
  if (actions.some((action) => action.type === "model.switch" || action.type === "turn.interrupt")) return "medium";
  if (actions.some((action) => action.type === "thread.switch" || action.type === "thread.create" || action.type === "thread.rename" || action.type === "thread.fork" || action.type === "conversation.switch")) return "low";
  return "read";
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
