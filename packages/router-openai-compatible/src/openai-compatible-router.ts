import { z } from "zod";
import type { VNextConfig } from "../../config/src/index.js";
import type {
  ConfigStorePort,
  IntentRouterInput,
  IntentRouterPort,
  RouterHealth,
  SecretStorePort
} from "../../ports/src/vnext/index.js";
import type { RoutingDecision } from "../../domain/src/vnext/index.js";

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
  confidence: z.number().min(0).max(1),
  clarification: z.string().min(1).optional()
}).strict().superRefine((decision, context) => {
  if (decision.kind === "control" && !decision.action) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["action"],
      message: "Control decisions require an action"
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
      if (decision.action && !input.allowedActionTypes.includes(decision.action.type)) {
        throw new Error(`Router returned disallowed action '${decision.action.type}'`);
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
    "You are an intent router. Return exactly one JSON object and no markdown.",
    `Choose kind chat, control, or clarify. Only choose control when confidence is at least ${controlThreshold}.`,
    "For control, include an action object. For clarify, include clarification.",
    `Allowed action types: ${JSON.stringify(input.allowedActionTypes)}`,
    `Space: ${JSON.stringify(input.spaceDisplayName)}`,
    `Current thread: ${JSON.stringify(input.currentThreadTitle)}`,
    `Candidate threads: ${JSON.stringify(input.candidateThreads)}`,
    `Recent control messages: ${JSON.stringify(input.recentControlMessages)}`,
    `User message: ${JSON.stringify(input.message)}`,
    "JSON shape: {\"kind\":\"chat|control|clarify\",\"action\":{\"type\":\"...\"},\"confidence\":0.0,\"clarification\":\"...\"}"
  ].join("\n");
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
