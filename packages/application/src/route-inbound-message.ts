import type {
  ControlAction,
  ConversationSpace,
  InboundEnvelope,
  RoutingDecision,
  ThreadBinding,
  Turn
} from "../../domain/src/vnext/index.js";
import type {
  Clock,
  CodexPort,
  IdGenerator,
  IntentRouterPort,
  RoutingDecisionRepository,
  ThreadBindingRepository
} from "../../ports/src/vnext/index.js";
import type {
  ControlActionExecution,
  ExecuteControlAction
} from "./execute-control-action.js";

export type RouteInboundMessageResult =
  | { kind: "chat" }
  | { kind: "reply"; text: string; format?: "plain" | "markdown" };

export const channelControlActionTypes = [
  "thread.list",
  "thread.current",
  "thread.switch",
  "thread.create",
  "thread.rename",
  "thread.fork",
  "turn.status",
  "turn.interrupt",
  "model.current",
  "model.switch",
  "quota.read",
  "system.status",
  "help"
] as const satisfies readonly ControlAction["type"][];

export class RouteInboundMessage {
  constructor(private readonly deps: {
    router: Pick<IntentRouterPort, "route" | "routeFast">;
    decisions: RoutingDecisionRepository;
    bindings: ThreadBindingRepository;
    codex: Pick<CodexPort, "listThreads">;
    controlActions: Pick<ExecuteControlAction, "execute">;
    ids: IdGenerator;
    clock: Clock;
    onRoutingError?(error: Error, message: InboundEnvelope): void;
  }) {}

  async execute(
    space: ConversationSpace,
    message: InboundEnvelope
  ): Promise<RouteInboundMessageResult> {
    const startedAt = Date.now();
    let decision: RoutingDecision;
    try {
      const fastDecision = await this.deps.router.routeFast?.({
        message: message.content.text,
        allowedActionTypes: [...channelControlActionTypes]
      }) ?? null;
      if (fastDecision) {
        decision = fastDecision;
      } else {
        const [binding, threads] = await Promise.all([
          this.deps.bindings.getActiveBySpace(space.spaceId),
          this.deps.codex.listThreads({ limit: 20 })
        ]);
        decision = await this.deps.router.route({
          message: message.content.text,
          spaceDisplayName: space.displayName,
          currentThreadTitle: binding?.threadTitle ?? null,
          candidateThreads: threads.map((thread) => ({
            title: thread.title,
            projectName: thread.projectName,
            relativeTime: thread.updatedAt
          })),
          recentControlMessages: [],
          allowedActionTypes: [...channelControlActionTypes]
        });
      }

    } catch (error) {
      this.deps.onRoutingError?.(normalizeError(error), message);
      return { kind: "chat" };
    }

    if (decision.kind === "chat") {
      await this.saveDecisionBestEffort(message, decision, startedAt, "chat");
      return { kind: "chat" };
    }
    if (decision.kind === "clarify") {
      await this.saveDecisionBestEffort(message, decision, startedAt, "clarification_sent");
      return {
        kind: "reply",
        text: decision.clarification ?? "请再具体说明你想执行的操作。",
        ...(space.channel === "feishu" ? { format: "markdown" as const } : {})
      };
    }
    const actions = decision.actions ?? (decision.action ? [decision.action] : []);
    if (actions.length === 0) {
      this.deps.onRoutingError?.(
        new Error("Router returned a control decision without actions"),
        message
      );
      return { kind: "chat" };
    }

    const replies: Array<{ text: string; format?: "plain" | "markdown" }> = [];
    let confirmationRequired = false;
    let failed = 0;
    for (const action of actions) {
      try {
        const execution = await this.deps.controlActions.execute({
          spaceId: space.spaceId,
          action,
          requestId: message.messageId
        });
        confirmationRequired ||= execution.status === "confirmation_required";
        replies.push(formatControlExecution(execution, space.channel));
      } catch (error) {
        failed += 1;
        this.deps.onRoutingError?.(normalizeError(error), message);
        replies.push({ text: `${actionLabel(action)} 执行失败：${normalizeError(error).message}` });
      }
    }
    await this.saveDecisionBestEffort(
      message,
      decision,
      startedAt,
      failed === 0 ? `control:completed:${actions.length}` : `control:partial:${failed}/${actions.length}`,
      confirmationRequired ? "pending" : "not_required"
    );
    return { kind: "reply", ...mergeControlReplies(replies) };
  }

  private async saveDecisionBestEffort(
    message: InboundEnvelope,
    decision: RoutingDecision,
    startedAt: number,
    result: string,
    confirmationStatus: Parameters<RoutingDecisionRepository["save"]>[0]["confirmationStatus"] = "not_required"
  ): Promise<void> {
    try {
      await this.saveDecision(message, decision, startedAt, result, confirmationStatus);
    } catch (error) {
      this.deps.onRoutingError?.(normalizeError(error), message);
    }
  }

  private saveDecision(
    message: InboundEnvelope,
    decision: RoutingDecision,
    startedAt: number,
    result: string,
    confirmationStatus: Parameters<RoutingDecisionRepository["save"]>[0]["confirmationStatus"] = "not_required"
  ): Promise<void> {
    return this.deps.decisions.save({
      decisionId: this.deps.ids.next(),
      spaceId: message.spaceId,
      messageId: message.messageId,
      decision,
      latencyMs: Math.max(0, Date.now() - startedAt),
      confirmationStatus,
      result,
      createdAt: this.deps.clock.now().toISOString()
    });
  }
}

function formatControlExecution(
  execution: ControlActionExecution,
  channel: ConversationSpace["channel"]
): { text: string; format?: "plain" | "markdown" } {
  if (execution.status === "confirmation_required") {
    return { text: `这个操作需要明确确认：${actionLabel(execution.action)}。请回复包含“确认”的完整指令。` };
  }
  switch (execution.action.type) {
    case "thread.current": {
      const binding = execution.data as ThreadBinding | null | undefined;
      return { text: binding
        ? `当前线程：${binding.threadTitle}\n线程 ID：${binding.threadId}`
        : "当前渠道尚未绑定任何线程。" };
    }
    case "thread.list": {
      const threads = Array.isArray(execution.data) ? execution.data as Array<{
        threadId: string;
        title: string;
        projectName: string | null;
      }> : [];
      if (threads.length === 0) return { text: "当前没有可用线程。" };
      if (channel === "feishu") {
        return {
          format: "markdown",
          text: [
            `当前共有 ${threads.length} 个可用线程：`,
            "",
            "| # | 线程 | 项目 | 线程 ID |",
            "| ---: | --- | --- | --- |",
            ...threads.map((thread, index) =>
              `| ${index + 1} | ${markdownTableCell(thread.title)} | ${markdownTableCell(thread.projectName ?? "—")} | ${markdownTableCell(thread.threadId)} |`
            )
          ].join("\n")
        };
      }
      return { text: [
        `当前共有 ${threads.length} 个可用线程：`,
        ...threads.map((thread, index) =>
          `${index + 1}. ${thread.title}${thread.projectName ? `（${thread.projectName}）` : ""}\n   ${thread.threadId}`
        )
      ].join("\n") };
    }
    case "thread.switch":
      return { text: `已切换到线程：${bindingTitle(execution.data) ?? "目标线程"}` };
    case "thread.create":
      return { text: `已创建并绑定线程：${bindingTitle(execution.data) ?? "新线程"}` };
    case "thread.rename":
      return { text: `线程已重命名为：${bindingTitle(execution.data) ?? execution.action.title}` };
    case "thread.fork":
      return { text: `已派生并绑定线程：${bindingTitle(execution.data) ?? "新线程"}` };
    case "turn.status": {
      const turns = Array.isArray(execution.data) ? execution.data as Turn[] : [];
      return { text: turns.length === 0
        ? "当前线程没有正在执行的任务。"
        : `当前有 ${turns.length} 个任务正在执行：\n${turns.map((turn) => `- ${turn.turnId}（${turn.status}）`).join("\n")}` };
    }
    case "turn.interrupt":
      return { text: execution.status === "completed" && Array.isArray(execution.data) && execution.data.length > 0
        ? "已中断当前任务。"
        : "当前没有可中断的任务。" };
    case "model.current": {
      const state = execution.data as { model?: string | null; reasoningEffort?: string | null } | undefined;
      return { text: `当前模型：${state?.model ?? "未知"}${state?.reasoningEffort ? `\n推理强度：${state.reasoningEffort}` : ""}` };
    }
    case "model.switch":
      return { text: `模型切换请求：${execution.action.model}\n${execution.message}` };
    case "quota.read": {
      const state = execution.data as { quotaSummary?: string | null } | undefined;
      return { text: `当前额度：${state?.quotaSummary ?? "暂无可用信息"}` };
    }
    case "system.status":
      return { text: `系统状态：${jsonSummary(execution.data)}` };
    case "help":
      return formatHelp(channel);
    default:
      return { text: execution.message };
  }
}

function formatHelp(channel: ConversationSpace["channel"]): {
  text: string;
  format?: "plain" | "markdown";
} {
  const commands = [
    ["查看最近线程", "/threads", "/t"],
    ["查看当前绑定线程", "/thread current", "/tc"],
    ["切换线程", "/thread use <序号>", "/tu <序号>"],
    ["新建线程", "/thread new <标题>", "/tn <标题>"],
    ["派生线程", "/thread fork <标题>", "/tf <标题>"],
    ["查看当前模型", "/model", "/m"],
    ["切换模型（需确认）", "/model use <名称>", "/mu <名称>"],
    ["查看额度", "/quota", "/q"],
    ["查看综合状态", "/status", "/st"],
    ["查看帮助", "/help", "/h"]
  ] as const;
  if (channel === "feishu") {
    return {
      format: "markdown",
      text: [
        "可用的桥接控制命令：",
        "",
        "| 用途 | 完整命令 | 简写 |",
        "| --- | --- | --- |",
        ...commands.map(([purpose, command, short]) =>
          `| ${purpose} | \`${command}\` | \`${short}\` |`
        ),
        "",
        "所有 `/` 开头的桥接命令都由本地控制层处理，不会发送给 Codex。"
      ].join("\n")
    };
  }
  return {
    text: [
      "可用的桥接控制命令：",
      ...commands.map(([purpose, command, short]) => `- ${purpose}：${command}（${short}）`),
      "所有 / 开头的桥接命令都由本地控制层处理，不会发送给 Codex。"
    ].join("\n")
  };
}

function markdownTableCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function mergeControlReplies(
  replies: Array<{ text: string; format?: "plain" | "markdown" }>
): { text: string; format?: "plain" | "markdown" } {
  if (replies.length === 1) return replies[0]!;
  const markdown = replies.some((reply) => reply.format === "markdown");
  return {
    text: replies.map((reply) => reply.text.trim()).filter(Boolean).join(markdown ? "\n\n---\n\n" : "\n\n"),
    ...(markdown ? { format: "markdown" as const } : {})
  };
}

function bindingTitle(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const title = (value as { threadTitle?: unknown }).threadTitle;
  return typeof title === "string" && title.trim() ? title : null;
}

function actionLabel(action: ControlAction): string {
  return action.type;
}

function jsonSummary(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "已完成检查";
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
