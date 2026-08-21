import type {
  ControlAction,
  ConversationAction,
  ConversationSpace,
  InboundEnvelope,
  RoutingDecision,
  RouterAction,
  SourceIdentity,
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
import type { ConversationResolver, ConversationResolution } from "./conversation-resolver.js";

export type RouteInboundMessageResult =
  | {
      kind: "conversation";
      target?: {
        binding: ThreadBinding;
        alias: string;
        source: SourceIdentity;
        matchedBy: "reply_reference" | "explicit_alias" | "active_conversation";
      };
    }
  | { kind: "reply"; text: string; format?: "plain" | "markdown"; source?: SourceIdentity };

export const channelRouterActionTypes = [
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
  "help",
  "channel.restart",
  "setup.channel.connect",
  "setup.channel.login",
  "approval.resolve",
  "conversation.list",
  "conversation.current",
  "conversation.switch"
] as const satisfies readonly RouterAction["type"][];

export class RouteInboundMessage {
  constructor(private readonly deps: {
    router: Pick<IntentRouterPort, "route" | "routeFast">;
    decisions: RoutingDecisionRepository;
    bindings: ThreadBindingRepository;
    codex: Pick<CodexPort, "listThreads">;
    controlActions: Pick<ExecuteControlAction, "execute">;
    conversationResolver?: ConversationResolver;
    systemActions?: {
      restartChannel(input: { channel: "qq" | "weixin" | "feishu"; accountId?: string }): Promise<unknown>;
      startSetup(input: { channel: "qq" | "weixin" | "feishu"; accountId?: string; force: boolean }): Promise<unknown>;
      resolveApproval(input: {
        resolution: "approve" | "decline";
        spaceId: ConversationSpace["spaceId"];
      }): Promise<unknown>;
    };
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
        allowedActionTypes: [...channelRouterActionTypes]
      }) ?? null;
      if (fastDecision) {
        decision = fastDecision;
      } else {
        const [binding, threads, conversations] = await Promise.all([
          this.deps.bindings.getActiveBySpace(space.spaceId),
          this.deps.codex.listThreads({ limit: 20 }),
          this.deps.conversationResolver?.listRecentConversations({ space, limit: 20 }) ?? Promise.resolve([])
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
          candidateConversations: conversations,
          recentControlMessages: [],
          allowedActionTypes: [...channelRouterActionTypes]
        });
      }

    } catch (error) {
      const normalized = normalizeError(error);
      this.deps.onRoutingError?.(normalized, message);
      const fallback: RoutingDecision = {
        kind: "conversation",
        confidence: 0,
        risk: "read",
        mode: "assist",
        fallbackReason: normalized.message
      };
      await this.saveDecisionBestEffort(message, fallback, startedAt, "conversation:fallback");
      return this.resolveConversation(space, message);
    }

    if (decision.fallbackReason && decision.fallbackReason !== "router_off") {
      this.deps.onRoutingError?.(new Error(decision.fallbackReason), message);
    }

    if (decision.kind === "conversation") {
      await this.saveDecisionBestEffort(message, decision, startedAt, "conversation");
      return this.resolveConversation(space, message);
    }
    if (decision.kind === "unknown") {
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
        new Error(`Router returned ${decision.kind} without actions`),
        message
      );
      return { kind: "conversation" };
    }

    const replies: Array<{ text: string; format?: "plain" | "markdown" }> = [];
    let confirmationRequired = false;
    let failed = 0;
    for (const action of actions) {
      try {
        const reply = await this.dispatchAction(action, space, message);
        confirmationRequired ||= reply.confirmationRequired;
        replies.push({
          text: reply.text,
          ...(reply.format ? { format: reply.format } : {})
        });
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
      failed === 0 ? `${decision.kind}:completed:${actions.length}` : `${decision.kind}:partial:${failed}/${actions.length}`,
      confirmationRequired ? "pending" : "not_required"
    );
    return { kind: "reply", ...mergeControlReplies(replies) };
  }

  private async dispatchAction(
    action: RouterAction,
    space: ConversationSpace,
    message: InboundEnvelope
  ): Promise<{ text: string; format?: "plain" | "markdown"; confirmationRequired: boolean }> {
    if (isConversationAction(action)) {
      return this.dispatchConversationAction(action, space);
    }
    if (isControlAction(action)) {
      const execution = await this.deps.controlActions.execute({
        spaceId: space.spaceId,
        action,
        requestId: message.messageId
      });
      return {
        ...formatControlExecution(execution, space.channel),
        confirmationRequired: execution.status === "confirmation_required"
      };
    }
    if (!this.deps.systemActions) throw new Error(`Router action '${action.type}' is unavailable`);
    if (action.type === "channel.restart") {
      await this.deps.systemActions.restartChannel({ channel: action.channel });
      return { text: `已重启${channelName(action.channel)}渠道。`, confirmationRequired: false };
    }
    if (action.type === "setup.channel.connect" || action.type === "setup.channel.login") {
      const result = await this.deps.systemActions.startSetup({
        channel: action.channel,
        ...(action.accountId ? { accountId: action.accountId } : {}),
        force: action.type === "setup.channel.login"
      });
      return { text: setupReply(result), confirmationRequired: false };
    }
    const result = await this.deps.systemActions.resolveApproval({
      resolution: action.resolution,
      spaceId: space.spaceId
    });
    return { text: approvalReply(result, action.resolution), confirmationRequired: false };
  }

  private async resolveConversation(
    space: ConversationSpace,
    message: InboundEnvelope
  ): Promise<RouteInboundMessageResult> {
    if (!this.deps.conversationResolver) return { kind: "conversation" };
    const resolution = await this.deps.conversationResolver.resolveInboundTarget({ space, message });
    if (!resolution) {
      const binding = await this.deps.bindings.getActiveBySpace(space.spaceId);
      if (!binding) return { kind: "conversation" };
      const source = await this.deps.conversationResolver.ensureActiveForBinding({ space, binding });
      return {
        kind: "conversation",
        target: {
          binding,
          alias: source.alias,
          source: await this.deps.conversationResolver.sourceForBinding(binding),
          matchedBy: "active_conversation"
        }
      };
    }
    if (resolution.kind === "clarify" || resolution.kind === "push_only") {
      return {
        kind: "reply",
        text: resolution.kind === "clarify" ? resolution.text : resolution.message,
        source: systemSource()
      };
    }
    if (resolution.matchedBy === "reply_reference" || resolution.matchedBy === "explicit_alias") {
      await this.deps.conversationResolver.setActiveForBinding({
        space,
        binding: resolution.binding,
        updatedBy: resolution.matchedBy === "reply_reference" ? "reply_reference" : "explicit_switch"
      });
    }
    return {
      kind: "conversation",
      target: {
        binding: resolution.binding,
        alias: resolution.alias.alias,
        source: resolution.source,
        matchedBy: resolution.matchedBy
      }
    };
  }

  private async dispatchConversationAction(
    action: ConversationAction,
    space: ConversationSpace
  ): Promise<{ text: string; format?: "plain" | "markdown"; confirmationRequired: boolean }> {
    if (!this.deps.conversationResolver) {
      throw new Error("Conversation Resolver is unavailable");
    }
    if (action.type === "conversation.list") {
      const sessions = await this.deps.conversationResolver.listRecentConversations({ space });
      if (sessions.length === 0) {
        return { text: "当前没有可用会话。", confirmationRequired: false };
      }
      const text = [
        "当前可用会话",
        ...sessions.map((session) => [
          `${session.active ? "●" : "○"} ${session.alias}`,
          `  ${session.provider} · ${session.title}`,
          `  ${session.capability === "push_only" ? "仅推送" : "可继续"}`
        ].join("\n"))
      ].join("\n\n");
      return { text, confirmationRequired: false };
    }
    if (action.type === "conversation.current") {
      const active = await this.deps.conversationResolver.getActiveConversation({ space });
      const sessions = await this.deps.conversationResolver.listRecentConversations({ space });
      const current = sessions.find((session) => session.active);
      if (!active || !current) {
        return { text: "当前尚未选择会话。发送 /sessions 查看可用会话。", confirmationRequired: false };
      }
      return { text: `当前会话：${current.provider} · ${current.title}\n${current.alias}`, confirmationRequired: false };
    }
    const alias = await this.deps.conversationResolver.setActiveConversation({
      space,
      alias: action.alias,
      updatedBy: "explicit_switch"
    });
    return {
      text: `已切换到：\n${alias.provider} · ${alias.taskTitle ?? alias.projectName ?? "未命名任务"}\n${alias.alias}`,
      confirmationRequired: false
    };
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

function actionLabel(action: RouterAction): string {
  return action.type;
}

function isControlAction(action: RouterAction): action is ControlAction {
  switch (action.type) {
    case "conversation.list":
    case "conversation.current":
    case "conversation.switch":
    case "channel.restart":
    case "setup.channel.connect":
    case "setup.channel.login":
    case "approval.resolve":
      return false;
    default:
      return true;
  }
}

function isConversationAction(action: RouterAction): action is ConversationAction {
  return action.type === "conversation.list"
    || action.type === "conversation.current"
    || action.type === "conversation.switch";
}

function systemSource(): SourceIdentity {
  return { provider: "system", capability: "system" };
}

function channelName(channel: "qq" | "weixin" | "feishu"): string {
  return { qq: "QQ", weixin: "微信", feishu: "飞书" }[channel];
}

function setupReply(result: unknown): string {
  if (!result || typeof result !== "object") return "Setup 已启动。";
  const session = result as { message?: unknown; artifact?: unknown };
  const message = typeof session.message === "string" ? session.message : "Setup 已启动。";
  const artifact = session.artifact;
  if (artifact && typeof artifact === "object"
    && (artifact as { type?: unknown }).type === "qr_code"
    && typeof (artifact as { content?: unknown }).content === "string") {
    return `${message}\n\n二维码内容：${(artifact as { content: string }).content}`;
  }
  return message;
}

function approvalReply(result: unknown, resolution: "approve" | "decline"): string {
  if (result && typeof result === "object" && typeof (result as { message?: unknown }).message === "string") {
    return (result as { message: string }).message;
  }
  return resolution === "approve" ? "已批准待处理请求。" : "已拒绝待处理请求。";
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
