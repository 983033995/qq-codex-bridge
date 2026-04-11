import { randomUUID } from "node:crypto";
import { BridgeSessionStatus, type BridgeSession } from "../../../packages/domain/src/session.js";
import { DesktopDriverError } from "../../../packages/domain/src/driver.js";
import type { ConversationEntry, InboundMessage, OutboundDraft } from "../../../packages/domain/src/message.js";
import type { DesktopDriverPort } from "../../../packages/ports/src/conversation.js";
import type { QqEgressPort } from "../../../packages/ports/src/qq.js";
import type { SessionStorePort, TranscriptStorePort } from "../../../packages/ports/src/store.js";

type ThreadCommandHandlerDeps = {
  sessionStore: SessionStorePort;
  transcriptStore: TranscriptStorePort;
  desktopDriver: DesktopDriverPort;
  qqEgress: QqEgressPort;
};

export class ThreadCommandHandler {
  constructor(private readonly deps: ThreadCommandHandlerDeps) {}

  async handleIfCommand(message: InboundMessage): Promise<boolean> {
    if (message.chatType !== "c2c") {
      return false;
    }

    const text = message.text.trim();
    if (!this.isSupportedCommand(text)) {
      return false;
    }

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

      if (text === "/threads" || text === "/t") {
        const threads = await this.deps.desktopDriver.listRecentThreads(20);
        await this.deliverControlReply(message, this.formatThreads(threads));
        return;
      }

      if (text === "/thread current" || text === "/tc") {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        const threads = await this.deps.desktopDriver.listRecentThreads(20);
        const current = threads.find((thread) => thread.threadRef === session?.codexThreadRef)
          ?? threads.find((thread) => thread.isCurrent)
          ?? null;
        const reply = current
          ? `当前绑定线程：${current.title}${current.projectName ? `\n项目：${current.projectName}` : ""}${current.relativeTime ? `\n最近活动：${current.relativeTime}` : ""}`
          : "当前私聊还没有绑定线程。";
        await this.deliverControlReply(message, reply);
        return;
      }

      if (text === "/help") {
        await this.deliverControlReply(message, this.buildHelpText());
        return;
      }

      const useMatch = text.match(/^(?:\/thread\s+use|\/tu)\s+(\d+)$/);
      if (useMatch) {
        const index = Number(useMatch[1]);
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
        await this.deliverControlReply(
          message,
          `已切换到线程：${thread.title}${thread.projectName ? `\n项目：${thread.projectName}` : ""}`
        );
        return;
      }

      const newMatch = text.match(/^(?:\/thread\s+new|\/tn)\s+(.+)$/);
      if (newMatch) {
        const title = newMatch[1].trim();
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
        this.buildHelpText()
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
      skillContextKey: null,
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
      /^\/thread\s+use\s+\d+$/.test(text) ||
      /^\/tu\s+\d+$/.test(text) ||
      /^\/thread\s+new\s+.+$/.test(text) ||
      /^\/tn\s+.+$/.test(text) ||
      /^\/thread\s+fork\s+.+$/.test(text) ||
      /^\/tf\s+.+$/.test(text) ||
      text === "/thread"
    );
  }

  private formatThreads(
    threads: Array<{
      index: number;
      title: string;
      projectName: string | null;
      relativeTime: string | null;
      isCurrent: boolean;
    }>
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
        const index = thread.isCurrent ? `→ ${thread.index}` : `${thread.index}`;
        const project = escapeCell(thread.projectName) || "-";
        const title = escapeCell(thread.title) || "-";
        const time = escapeCell(thread.relativeTime) || "-";
        return `| ${index} | ${project} | ${title} | ${time} |`;
      })
    ].join("\n");
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

  private buildHelpText(): string {
    return [
      "线程管理命令：",
      "",
      "| 用途 | 完整命令 | 简写 |",
      "| --- | --- | --- |",
      "| 查看最近活跃线程 | `/threads` | `/t` |",
      "| 查看当前绑定线程 | `/thread current` | `/tc` |",
      "| 切换到指定线程 | `/thread use <序号>` | `/tu <序号>` |",
      "| 新建线程 | `/thread new <标题>` | `/tn <标题>` |",
      "| 基于最近对话 fork 线程 | `/thread fork <标题>` | `/tf <标题>` |",
      "",
      "建议先发 `/t` 看列表，再用 `/tu 2` 这种方式切换。"
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
