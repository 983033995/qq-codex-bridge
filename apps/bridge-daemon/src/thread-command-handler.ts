import { randomUUID } from "node:crypto";
import { BridgeSessionStatus, type BridgeSession, type ConversationProviderKind } from "../../../packages/domain/src/session.js";
import type { ChatgptDesktopDriver } from "../../../packages/adapters/chatgpt-desktop/src/driver.js";
import { ensureAppVisible } from "../../../packages/adapters/chatgpt-desktop/src/ax-client.js";
import { DesktopDriverError, type CodexControlState } from "../../../packages/domain/src/driver.js";
import type { ConversationEntry, InboundMessage, OutboundDraft } from "../../../packages/domain/src/message.js";
import type { DesktopDriverPort } from "../../../packages/ports/src/conversation.js";
import type { QqEgressPort } from "../../../packages/ports/src/qq.js";
import type { SessionStorePort, TranscriptStorePort } from "../../../packages/ports/src/store.js";

type ThreadCommandHandlerDeps = {
  sessionStore: SessionStorePort;
  transcriptStore: TranscriptStorePort;
  desktopDriver: DesktopDriverPort;
  qqEgress: QqEgressPort;
  chatgptDesktopAvailable?: boolean;
  chatgptDriver?: ChatgptDesktopDriver;
  accountKeys?: string[];
};

export class ThreadCommandHandler {
  private readonly chatgptThreadListRefreshSessionKeys = new Set<string>();

  constructor(private readonly deps: ThreadCommandHandlerDeps) {}

  async handleIfCommand(message: InboundMessage): Promise<boolean> {
    if (message.chatType !== "c2c") {
      return false;
    }

    const text = message.text.trim();
    if (!text.startsWith("/")) {
      return false;
    }
    const supportedCommand = this.isSupportedCommand(text);

    const alreadySeen = await this.deps.transcriptStore.hasInbound(message.messageId);
    if (alreadySeen) {
      return true;
    }

    await this.deps.sessionStore.withSessionLock(message.sessionKey, async () => {
      const seenInsideLock = await this.deps.transcriptStore.hasInbound(message.messageId);
      if (seenInsideLock) {
        return;
      }

      await this.ensureSessionExists(message);
      await this.deps.transcriptStore.recordInbound(message);

      if (!supportedCommand) {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        await this.deliverControlReply(
          message,
          this.buildUnknownCommandText(text, this.currentProvider(session))
        );
        return;
      }

      if (text === "/threads" || text === "/t") {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        if (this.currentProvider(session) === "chatgpt-desktop") {
          await this.deliverChatgptThreads(message, session);
          return;
        }
        const threads = await this.deps.desktopDriver.listRecentThreads(20);
        await this.deliverControlReply(
          message,
          this.formatThreads(threads, session?.codexThreadRef ?? null)
        );
        return;
      }

      if (text === "/thread current" || text === "/tc") {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        if (this.currentProvider(session) === "chatgpt-desktop") {
          await this.deliverChatgptCurrentThread(message, session);
          return;
        }
        const threads = await this.deps.desktopDriver.listRecentThreads(20);
        const current = threads.find(
          (thread) =>
            session?.codexThreadRef
            && areThreadRefsEquivalent(thread.threadRef, session.codexThreadRef)
        )
          ?? threads.find((thread) => thread.isCurrent)
          ?? null;
        const reply = current
          ? `当前绑定线程：${current.title}${current.projectName ? `\n项目：${current.projectName}` : ""}${current.relativeTime ? `\n最近活动：${current.relativeTime}` : ""}`
          : "当前私聊还没有绑定线程。";
        await this.deliverControlReply(message, reply);
        return;
      }

      const sourceMatch = text.match(/^\/source\s+(codex|chatgpt)$/);
      if (sourceMatch) {
        const target = sourceMatch[1] === "chatgpt" ? "chatgpt-desktop" : "codex-desktop";
        await this.deps.sessionStore.updateConversationProvider(message.sessionKey, target);
        if (target === "chatgpt-desktop") {
          this.chatgptThreadListRefreshSessionKeys.add(message.sessionKey);
        } else {
          this.chatgptThreadListRefreshSessionKeys.delete(message.sessionKey);
        }
        const label = target === "chatgpt-desktop" ? "ChatGPT Desktop" : "Codex Desktop";
        await this.deliverControlReply(message, `已切换对话源：${label}\n后续消息将通过 ${label} 回复。`);
        return;
      }

      if (text === "/source") {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        const current = session?.conversationProvider ?? "codex-desktop（全局默认）";
        await this.deliverControlReply(message, `当前对话源：${current}\n切换：/source codex 或 /source chatgpt`);
        return;
      }

      if (text === "/accounts") {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        await this.deliverControlReply(message, this.buildAccountsText(message, session));
        return;
      }

      if (text === "/cgpt" || text === "/cgpt threads") {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        await this.deliverChatgptThreads(message, session);
        return;
      }

      const cgptUseMatch = text.match(/^\/cgpt\s+use\s+(\d+)$/);
      if (cgptUseMatch) {
        const cgDriver = this.deps.chatgptDriver;
        if (!cgDriver) {
          await this.deliverControlReply(message, "ChatGPT Desktop 未启用。");
          return;
        }
        const index = Number(cgptUseMatch[1]);
        const chats = cgDriver.listChats(20);
        const target = chats[index - 1];
        if (!target) {
          await this.deliverControlReply(message, `没有第 ${index} 条对话，请先发 /cgpt 查看列表。`);
          return;
        }
        const switched = cgDriver.switchToChat(target.title);
        if (!switched) {
          await this.deliverControlReply(message, `切换失败：在侧边栏未找到「${target.title}」，请重试或刷新列表。`);
          return;
        }
        // 写入当前对话标题，下次 run() 检测到后跳过 clickNewChat
        cgDriver.markSwitched(message.sessionKey, target.title);
        await this.deliverControlReply(message, `已切换到 ChatGPT 对话：${target.title}\n下次消息将继续该对话。`);
        return;
      }

      if (text === "/cgpt new") {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        await this.createChatgptThread(message, session);
        return;
      }

      if (text === "/help") {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        await this.deliverControlReply(message, this.buildHelpText(this.currentProvider(session)));
        return;
      }

      if (text === "/h") {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        await this.deliverControlReply(message, this.buildHelpText(this.currentProvider(session)));
        return;
      }

      if (text === "/model" || text === "/m") {
        const state = await this.deps.desktopDriver.getControlState();
        await this.deliverControlReply(message, this.formatModelReply(state));
        return;
      }

      const switchModelMatch = text.match(/^(?:\/model\s+use|\/mu)\s+(.+)$/);
      if (switchModelMatch) {
        const targetModel = switchModelMatch[1].trim();
        try {
          const state = await this.deps.desktopDriver.switchModel(targetModel);
          await this.deliverControlReply(message, this.formatModelSwitchReply(targetModel, state));
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await this.deliverControlReply(
            message,
            `切换模型失败：${reason}\n请检查模型名称是否正确，或当前 Codex Desktop 界面是否可操作。`
          );
        }
        return;
      }

      if (text === "/quota" || text === "/q") {
        const quotaSummary = await this.deps.desktopDriver.getQuotaSummary();
        await this.deliverControlReply(message, this.formatQuotaReply(quotaSummary));
        return;
      }

      if (text === "/status" || text === "/st") {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        const state = await this.deps.desktopDriver.getControlState(
          session
            ? {
                sessionKey: session.sessionKey,
                codexThreadRef: session.codexThreadRef
              }
            : null
        );
        const quotaSummary = await this.deps.desktopDriver.getQuotaSummary();
        await this.deliverControlReply(message, this.formatStatusReply(session, state, quotaSummary));
        return;
      }

      const useMatch = text.match(/^(?:\/thread\s+use|\/tu)\s+(\d+)$/);
      if (useMatch) {
        const index = Number(useMatch[1]);
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        if (this.currentProvider(session) === "chatgpt-desktop") {
          await this.useChatgptThread(message, index);
          return;
        }
        const threads = await this.deps.desktopDriver.listRecentThreads(20);
        const thread = threads[index - 1];
        if (!thread) {
          await this.deliverControlReply(message, `没有第 ${index} 个线程。请先发送 /threads 查看列表。`);
          return;
        }

        let binding;
        try {
          binding = await this.deps.desktopDriver.switchToThread(message.sessionKey, thread.threadRef);
        } catch (error) {
          if (error instanceof DesktopDriverError && error.reason === "session_not_found") {
            await this.deliverControlReply(
              message,
              `切换失败：没有在当前 Codex 侧边栏里找到这个线程。\n请先发送 /t 刷新列表后重试。`
            );
            return;
          }
          throw error;
        }
        await this.deps.sessionStore.updateBinding(message.sessionKey, binding.codexThreadRef);
        await this.deps.sessionStore.updateSkillContextKey(message.sessionKey, null);
        await this.deliverControlReply(
          message,
          [
            `已切换到线程：${thread.title}`,
            ...(thread.projectName ? [`项目：${thread.projectName}`] : []),
            `绑定标识：${binding.codexThreadRef ?? "未绑定"}`
          ].join("\n")
        );
        return;
      }

      const newMatch = text.match(/^(?:\/thread\s+new|\/tn)\s+(.+)$/);
      if (newMatch) {
        const title = newMatch[1].trim();
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        if (this.currentProvider(session) === "chatgpt-desktop") {
          await this.createChatgptThread(message, session);
          return;
        }
        const binding = await this.deps.desktopDriver.createThread(
          message.sessionKey,
          this.buildNewThreadSeedPrompt(title)
        );
        await this.deps.sessionStore.updateBinding(message.sessionKey, binding.codexThreadRef);
        await this.deliverControlReply(message, `已创建并切换到新线程：${title}`);
        return;
      }

      const forkMatch = text.match(/^(?:\/thread\s+fork|\/tf)\s+(.+)$/);
      if (forkMatch) {
        const title = forkMatch[1].trim();
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        if (this.currentProvider(session) === "chatgpt-desktop") {
          await this.createChatgptThread(message, session);
          return;
        }
        const recentConversation = await this.deps.transcriptStore.listRecentConversation(
          message.sessionKey,
          8
        );
        const binding = await this.deps.desktopDriver.createThread(
          message.sessionKey,
          this.buildForkThreadSeedPrompt(title, recentConversation)
        );
        await this.deps.sessionStore.updateBinding(message.sessionKey, binding.codexThreadRef);
        await this.deliverControlReply(message, `已根据最近几轮对话 fork 新线程：${title}`);
        return;
      }

      await this.deliverControlReply(
        message,
        this.buildHelpText(this.currentProvider(await this.deps.sessionStore.getSession(message.sessionKey)))
      );
    });

    return true;
  }

  private async ensureSessionExists(message: InboundMessage): Promise<void> {
    const existing = await this.deps.sessionStore.getSession(message.sessionKey);
    if (existing) {
      return;
    }

    const created: BridgeSession = {
      sessionKey: message.sessionKey,
      accountKey: message.accountKey,
      peerKey: message.peerKey,
      chatType: message.chatType,
      peerId: message.senderId,
      codexThreadRef: null,
      lastCodexTurnId: null,
      skillContextKey: null,
      conversationProvider: null,
      status: BridgeSessionStatus.Active,
      lastInboundAt: message.receivedAt,
      lastOutboundAt: null,
      lastError: null
    };

    await this.deps.sessionStore.createSession(created);
  }

  private isSupportedCommand(text: string): boolean {
    return (
      text === "/threads" ||
      text === "/t" ||
      text === "/thread current" ||
      text === "/tc" ||
      text === "/help" ||
      text === "/h" ||
      text === "/accounts" ||
      text === "/model" ||
      text === "/m" ||
      text === "/quota" ||
      text === "/q" ||
      text === "/status" ||
      text === "/st" ||
      /^\/thread\s+use\s+\d+$/.test(text) ||
      /^\/tu\s+\d+$/.test(text) ||
      /^\/model\s+use\s+.+$/.test(text) ||
      /^\/mu\s+.+$/.test(text) ||
      /^\/thread\s+new\s+.+$/.test(text) ||
      /^\/tn\s+.+$/.test(text) ||
      /^\/thread\s+fork\s+.+$/.test(text) ||
      /^\/tf\s+.+$/.test(text) ||
      text === "/thread" ||
      text === "/cgpt" ||
      text === "/cgpt threads" ||
      text === "/cgpt new" ||
      /^\/cgpt\s+use\s+\d+$/.test(text) ||
      text === "/source" ||
      /^\/source\s+(codex|chatgpt)$/.test(text)
    );
  }

  private formatThreads(
    threads: Array<{
      index: number;
      title: string;
      projectName: string | null;
      relativeTime: string | null;
      isCurrent: boolean;
      threadRef?: string;
    }>,
    boundThreadRef: string | null = null
  ): string {
    if (threads.length === 0) {
      return "当前没有可用的 Codex 线程。";
    }

    const escapeCell = (value: string | null) =>
      (value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").trim();

    return [
      "最近 20 条最近有消息活动的 Codex 线程：",
      "",
      "| 序号 | 项目 | 线程标题 | 最近活动 |",
      "| --- | --- | --- | --- |",
      ...threads.map((thread) => {
        const isBound = Boolean(
          boundThreadRef
          && thread.threadRef
          && areThreadRefsEquivalent(thread.threadRef, boundThreadRef)
        );
        const shouldMark = boundThreadRef ? isBound : thread.isCurrent;
        const index = shouldMark ? `👉🏻 ${thread.index}` : `${thread.index}`;
        const project = escapeCell(thread.projectName) || "-";
        const title = escapeCell(thread.title) || "-";
        const time = escapeCell(thread.relativeTime) || "-";
        return `| ${index} | ${project} | ${title} | ${time} |`;
      })
    ].join("\n");
  }

  private currentProvider(session: BridgeSession | null): ConversationProviderKind {
    return session?.conversationProvider ?? "codex-desktop";
  }

  private async deliverChatgptThreads(
    message: InboundMessage,
    session: BridgeSession | null
  ): Promise<void> {
    const cgDriver = this.deps.chatgptDriver;
    if (!cgDriver) {
      await this.deliverControlReply(message, "ChatGPT Desktop 未启用，请先 /source chatgpt 切换。");
      return;
    }
    const shouldRefresh = this.chatgptThreadListRefreshSessionKeys.delete(message.sessionKey);
    try { ensureAppVisible(); } catch { /* non-fatal */ }
    const currentRef = session ? cgDriver.getSessionThreadRef(session.sessionKey) : null;
    const currentWindowTitle = cgDriver.getCurrentThreadTitle();
    const chats = this.listChatgptChats(cgDriver, shouldRefresh);
    if (chats.length === 0) {
      await this.deliverControlReply(message, "ChatGPT 侧边栏未读取到对话列表。请确保 ChatGPT Desktop 已启动且有历史对话。");
      return;
    }
    const escapeCell = (v: string) => v.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
    const lines = [
      "最近 20 条 ChatGPT 对话：",
      "",
      "| 序号 | 对话标题 |",
      "| --- | --- |",
      ...chats.map((c) => {
        const mark = this.isCurrentChatgptChat(c.title, currentRef, currentWindowTitle) ? "👉🏻 " : "";
        return `| ${mark}${c.index} | ${escapeCell(c.title)} |`;
      })
    ];
    await this.deliverControlReply(message, lines.join("\n"));
  }

  private listChatgptChats(cgDriver: ChatgptDesktopDriver, shouldRefresh: boolean) {
    const chats = cgDriver.listChats(20);
    if (!shouldRefresh && chats.length > 0) {
      return chats;
    }

    const refreshedChats = cgDriver.listChats(20);
    return refreshedChats.length > 0 ? refreshedChats : chats;
  }

  private async deliverChatgptCurrentThread(
    message: InboundMessage,
    session: BridgeSession | null
  ): Promise<void> {
    const cgDriver = this.deps.chatgptDriver;
    if (!cgDriver) {
      await this.deliverControlReply(message, "ChatGPT Desktop 未启用，请先 /source chatgpt 切换。");
      return;
    }
    const currentRef = session ? cgDriver.getSessionThreadRef(session.sessionKey) : null;
    await this.deliverControlReply(
      message,
      currentRef ? `当前绑定 ChatGPT 对话：${currentRef}` : "当前私聊还没有绑定 ChatGPT 对话。"
    );
  }

  private async useChatgptThread(message: InboundMessage, index: number): Promise<void> {
    const cgDriver = this.deps.chatgptDriver;
    if (!cgDriver) {
      await this.deliverControlReply(message, "ChatGPT Desktop 未启用。");
      return;
    }
    const chats = cgDriver.listChats(20);
    const target = chats[index - 1];
    if (!target) {
      await this.deliverControlReply(message, `没有第 ${index} 条 ChatGPT 对话，请先发 /threads 查看列表。`);
      return;
    }
    const switched = cgDriver.switchToChat(target.title);
    if (!switched) {
      await this.deliverControlReply(message, `切换失败：在 ChatGPT 侧边栏未找到「${target.title}」，请重试或刷新列表。`);
      return;
    }
    cgDriver.markSwitched(message.sessionKey, target.title);
    await this.deliverControlReply(message, `已切换到 ChatGPT 对话：${target.title}\n下次消息将继续该对话。`);
  }

  private isCurrentChatgptChat(
    title: string,
    currentRef: string | null,
    currentWindowTitle: string | null
  ): boolean {
    const normalizedTitle = normalizeChatgptTitle(title);
    const normalizedRef = currentRef && currentRef !== "__switched__"
      ? normalizeChatgptTitle(currentRef)
      : "";
    if (normalizedRef && normalizedTitle === normalizedRef) {
      return true;
    }

    const normalizedWindowTitle = currentWindowTitle ? normalizeChatgptTitle(currentWindowTitle) : "";
    return Boolean(
      normalizedWindowTitle
      && normalizedTitle
      && (
        normalizedWindowTitle === normalizedTitle
        || normalizedWindowTitle.includes(normalizedTitle)
      )
    );
  }

  private async createChatgptThread(
    message: InboundMessage,
    session: BridgeSession | null
  ): Promise<void> {
    const cgDriver = this.deps.chatgptDriver;
    if (!cgDriver) {
      await this.deliverControlReply(message, "ChatGPT Desktop 未启用。");
      return;
    }
    cgDriver.newChat(session?.sessionKey ?? message.sessionKey);
    await this.deliverControlReply(message, "已为本会话新建 ChatGPT 对话，下条消息将从新对话开始。");
  }

  private async deliverControlReply(message: InboundMessage, text: string): Promise<void> {
    const draft: OutboundDraft = {
      draftId: randomUUID(),
      sessionKey: message.sessionKey,
      text,
      createdAt: new Date().toISOString(),
      replyToMessageId: message.messageId
    };

    await this.deps.transcriptStore.recordOutbound(draft);
    await this.deps.qqEgress.deliver(draft);
  }

  private buildHelpText(provider: ConversationProviderKind = "codex-desktop"): string {
    if (provider === "chatgpt-desktop") {
      return [
        "快捷命令（当前源：ChatGPT Desktop）：",
        "",
        "| 用途 | 完整命令 | 简写 |",
        "| --- | --- | --- |",
        "| 查看 ChatGPT 最近对话 | `/threads` | `/t` |",
        "| 查看当前绑定 ChatGPT 对话 | `/thread current` | `/tc` |",
        "| 切换 ChatGPT 对话 | `/thread use <序号>` | `/tu <序号>` |",
        "| 新建 ChatGPT 对话 | `/thread new <标题>` | `/tn <标题>` |",
        "| 查看当前对话源 | `/source` | - |",
        "| 查看账号状态 | `/accounts` | - |",
        "| 切换到 Codex Desktop | `/source codex` | - |",
        "| 查看帮助 | `/help` | `/h` |",
        "",
        "建议先发 `/t` 刷新并查看 ChatGPT 对话列表，再用 `/tu 2` 切换。",
        "模型、额度、状态和真正的 fork 命令目前只适用于 Codex Desktop。"
      ].join("\n");
    }

    return [
      "快捷命令（当前源：Codex Desktop）：",
      "",
      "| 用途 | 完整命令 | 简写 |",
      "| --- | --- | --- |",
      "| 查看 Codex 最近线程 | `/threads` | `/t` |",
      "| 查看当前绑定 Codex 线程 | `/thread current` | `/tc` |",
      "| 切换 Codex 线程 | `/thread use <序号>` | `/tu <序号>` |",
      "| 新建 Codex 线程 | `/thread new <标题>` | `/tn <标题>` |",
      "| 基于最近对话 fork Codex 线程 | `/thread fork <标题>` | `/tf <标题>` |",
      "| 查看当前模型 | `/model` | `/m` |",
      "| 切换模型 | `/model use <名称>` | `/mu <名称>` |",
      "| 查看额度信息 | `/quota` | `/q` |",
      "| 查看当前运行状态 | `/status` | `/st` |",
      "| 查看帮助 | `/help` | `/h` |",
      "| 查看当前对话源 | `/source` | - |",
      "| 查看账号状态 | `/accounts` | - |",
      "| 切换到 ChatGPT Desktop | `/source chatgpt` | - |",
      "| 切换到 Codex Desktop | `/source codex` | - |",
      "",
      "所有 `/` 开头的桥接快捷指令都会先由桥接层处理，不会直接发给 Codex。",
      "建议先用 `/source` 确认当前对话源，再发 `/t` 看列表，用 `/tu 2` 切换。",
      "切到 ChatGPT 后，这套 `/t`、`/tu`、`/tn` 会自动操作 ChatGPT 对话。"
    ].join("\n");
  }

  private buildUnknownCommandText(text: string, provider: ConversationProviderKind): string {
    return [
      `未识别的桥接快捷指令：\`${text}\``,
      "这条 `/` 指令不会转发给当前对话源。",
      "",
      this.buildHelpText(provider)
    ].join("\n");
  }

  private buildAccountsText(message: InboundMessage, session: BridgeSession | null): string {
    const currentProvider = this.currentProvider(session);
    const accountKeys = [...new Set(this.deps.accountKeys ?? [message.accountKey])].sort();
    return [
      "账号状态：",
      "",
      "| 项目 | 值 |",
      "| --- | --- |",
      `| 当前账号 | ${escapeMarkdownCell(message.accountKey)} |`,
      `| 当前来源 | ${message.accountKey.startsWith("weixin:") ? "微信" : "QQ"} |`,
      `| 当前会话 | ${escapeMarkdownCell(message.sessionKey)} |`,
      `| 当前对话源 | ${currentProvider} |`,
      `| 已接入账号 | ${accountKeys.map(escapeMarkdownCell).join(", ")} |`
    ].join("\n");
  }

  private formatModelReply(state: CodexControlState): string {
    return [
      `当前模型：${state.model ?? "未识别"}`,
      `推理强度：${state.reasoningEffort ?? "未识别"}`,
      `工作区：${state.workspace ?? "未识别"}`,
      `分支：${state.branch ?? "未识别"}`
    ].join("\n");
  }

  private formatModelSwitchReply(targetModel: string, state: CodexControlState): string {
    return [
      `已切换模型：${state.model ?? targetModel}`,
      `推理强度：${state.reasoningEffort ?? "未识别"}`,
      `工作区：${state.workspace ?? "未识别"}`
    ].join("\n");
  }

  private formatQuotaReply(quotaSummary: string | null): string {
    return `额度信息：${quotaSummary ?? "当前界面未显示明确额度，暂未识别到剩余配额。"}`;
  }

  private formatStatusReply(
    session: BridgeSession | null,
    state: CodexControlState,
    quotaSummary: string | null
  ): string {
    const boundThreadRef = state.threadRef ?? session?.codexThreadRef ?? null;
    return [
      "当前运行状态：",
      `线程绑定：${boundThreadRef ?? "未绑定"}`,
      ...(state.threadTitle ? [`线程标题：${state.threadTitle}`] : []),
      ...(state.threadProjectName ? [`线程项目：${state.threadProjectName}`] : []),
      ...(state.threadRelativeTime ? [`线程最近活动：${state.threadRelativeTime}`] : []),
      `模型：${state.model ?? "未识别"}`,
      `推理强度：${state.reasoningEffort ?? "未识别"}`,
      `工作区：${state.workspace ?? "未识别"}`,
      `分支：${state.branch ?? "未识别"}`,
      `权限：${state.permissionMode ?? "未识别"}`,
      `额度：${quotaSummary ?? "当前界面未显示明确额度，暂未识别到剩余配额。"}`
    ].join("\n");
  }

  private buildNewThreadSeedPrompt(title: string): string {
    return [
      `线程标题：${title}`,
      "",
      "这是一个刚创建的新线程。",
      "请把上面的标题视为本线程主题。",
      "现在无需展开分析，只需理解上下文并等待我的下一条消息。"
    ].join("\n");
  }

  private buildForkThreadSeedPrompt(title: string, entries: ConversationEntry[]): string {
    const summaryLines = entries.map((entry) => {
      const speaker = entry.direction === "inbound" ? "用户" : "助手";
      return `- ${speaker}：${entry.text}`;
    });

    return [
      `线程标题：${title}`,
      "",
      "这是从另一个 QQ 私聊会话中 fork 出来的新线程。",
      "以下是最近几轮 QQ 对话摘要，请把它们作为本线程的起始上下文：",
      ...(summaryLines.length > 0 ? summaryLines : ["- 暂无可用对话摘要"]),
      "",
      "请理解上下文，等待我的下一条消息。"
    ].join("\n");
  }
}

function areThreadRefsEquivalent(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }

  const leftAppThreadId = extractAppServerThreadId(left);
  const rightAppThreadId = extractAppServerThreadId(right);
  return Boolean(leftAppThreadId && rightAppThreadId && leftAppThreadId === rightAppThreadId);
}

function extractAppServerThreadId(threadRef: string): string | null {
  const prefix = "codex-app-thread:";
  if (!threadRef.startsWith(prefix)) {
    return null;
  }

  const payload = threadRef.slice(prefix.length);
  const separatorIndex = payload.indexOf(":");
  const threadId = separatorIndex >= 0 ? payload.slice(0, separatorIndex) : payload;
  return threadId.trim() ? threadId : null;
}

function normalizeChatgptTitle(value: string): string {
  return value
    .replace(/^chatgpt\s*[-–—:|]?\s*/i, "")
    .replace(/\s*[-–—:|]?\s*chatgpt$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}
