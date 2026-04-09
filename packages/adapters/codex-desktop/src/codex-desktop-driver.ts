import { randomUUID } from "node:crypto";
import {
  DesktopDriverError,
  type CodexThreadSummary,
  type DriverBinding
} from "../../../domain/src/driver.js";
import type { InboundMessage, OutboundDraft } from "../../../domain/src/message.js";
import type { DesktopDriverPort } from "../../../ports/src/conversation.js";
import { CdpSession } from "./cdp-session.js";
import { isLikelyComposerSubmitButton } from "./composer-heuristics.js";
import { parseAssistantReply } from "./reply-parser.js";

const TARGET_REF_PREFIX = "cdp-target:";
const THREAD_REF_PREFIX = "codex-thread:";

type RawSidebarThread = {
  title: string;
  projectName: string | null;
  relativeTime: string | null;
  isCurrent: boolean;
};

type ThreadLocator = {
  pageId: string;
  title: string;
  projectName: string | null;
};

type CodexDesktopDriverOptions = {
  replyPollAttempts?: number;
  replyPollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export class CodexDesktopDriver implements DesktopDriverPort {
  private readonly replyPollAttempts: number;
  private readonly replyPollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pendingReplyBaselines = new Map<string, string | null>();

  constructor(
    private readonly cdp: CdpSession,
    options: CodexDesktopDriverOptions = {}
  ) {
    this.replyPollAttempts = options.replyPollAttempts ?? 60;
    this.replyPollIntervalMs = options.replyPollIntervalMs ?? 500;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  async ensureAppReady(): Promise<void> {
    await this.cdp.connect();
    const targets = await this.cdp.listTargets();
    const hasPageTarget = targets.some((target) => target.type === "page");

    if (!hasPageTarget) {
      throw new DesktopDriverError(
        "Codex desktop app is not exposing any inspectable page target",
        "app_not_ready"
      );
    }
  }

  async openOrBindSession(
    sessionKey: string,
    binding: DriverBinding | null
  ): Promise<DriverBinding> {
    const pageTarget = await this.resolvePageTarget();
    const pageId = pageTarget.id;

    if (binding?.codexThreadRef === `${TARGET_REF_PREFIX}${pageId}`) {
      return binding;
    }

    if (binding?.codexThreadRef?.startsWith(THREAD_REF_PREFIX)) {
      const locator = this.decodeThreadRef(binding.codexThreadRef);
      if (locator && locator.pageId === pageId) {
        const threads = await this.listRecentThreads(200);
        const matched = threads.find((thread) => thread.threadRef === binding.codexThreadRef);
        if (matched) {
          return binding;
        }
      }
    }

    const currentThread = (await this.listRecentThreads(200)).find((thread) => thread.isCurrent);
    if (currentThread) {
      return {
        sessionKey,
        codexThreadRef: currentThread.threadRef
      };
    }

    return {
      sessionKey,
      codexThreadRef: `${TARGET_REF_PREFIX}${pageId}`
    };
  }

  async listRecentThreads(limit: number): Promise<CodexThreadSummary[]> {
    const pageTarget = await this.resolvePageTarget();
    const rawThreads = (await this.cdp.evaluateOnPage(
      this.buildThreadListScript(limit),
      pageTarget.id
    )) as RawSidebarThread[] | null;

    if (!Array.isArray(rawThreads)) {
      return [];
    }

    return rawThreads.map((thread, index) => ({
      index: index + 1,
      title: thread.title,
      projectName: thread.projectName,
      relativeTime: thread.relativeTime,
      isCurrent: thread.isCurrent,
      threadRef: this.encodeThreadRef({
        pageId: pageTarget.id,
        title: thread.title,
        projectName: thread.projectName
      })
    }));
  }

  async switchToThread(sessionKey: string, threadRef: string): Promise<DriverBinding> {
    const locator = this.decodeThreadRef(threadRef);
    if (!locator) {
      throw new DesktopDriverError("Codex thread binding is invalid", "session_not_found");
    }

    const result = (await this.cdp.evaluateOnPage(
      this.buildSelectThreadScript(locator),
      locator.pageId
    )) as { ok?: boolean; reason?: string } | undefined;

    if (!result?.ok) {
      throw new DesktopDriverError(
        `Codex desktop thread switch failed: ${result?.reason ?? "unknown"}`,
        "session_not_found"
      );
    }

    return {
      sessionKey,
      codexThreadRef: threadRef
    };
  }

  async createThread(sessionKey: string, seedPrompt: string): Promise<DriverBinding> {
    const pageTarget = await this.resolvePageTarget();
    const clickResult = (await this.cdp.evaluateOnPage(
      this.buildNewThreadScript(),
      pageTarget.id
    )) as { ok?: boolean; reason?: string } | undefined;

    if (!clickResult?.ok) {
      throw new DesktopDriverError(
        `Codex desktop new thread failed: ${clickResult?.reason ?? "unknown"}`,
        "session_not_found"
      );
    }

    await this.waitForFreshThreadContext(pageTarget.id);

    const temporaryBinding: DriverBinding = {
      sessionKey,
      codexThreadRef: `${TARGET_REF_PREFIX}${pageTarget.id}`
    };

    if (seedPrompt.trim()) {
      await this.sendUserMessage(temporaryBinding, {
        messageId: `thread-seed:${randomUUID()}`,
        accountKey: "qqbot:default",
        sessionKey,
        peerKey: "qq:c2c:thread-control",
        chatType: "c2c",
        senderId: "thread-control",
        text: seedPrompt,
        receivedAt: new Date().toISOString()
      });
      await this.collectAssistantReply(temporaryBinding);
    }

    return temporaryBinding;
  }

  async sendUserMessage(binding: DriverBinding, message: InboundMessage): Promise<void> {
    const targetId = await this.ensureThreadSelected(binding);
    const baselineReply = await this.readLatestAssistantReply(targetId);
    this.pendingReplyBaselines.set(binding.sessionKey, baselineReply);

    const focusResult = (await this.cdp.evaluateOnPage(
      this.buildFocusComposerScript(),
      targetId
    )) as { ok?: boolean; reason?: string } | undefined;

    if (!focusResult?.ok) {
      this.pendingReplyBaselines.delete(binding.sessionKey);
      throw new DesktopDriverError(
        `Codex desktop input box not found: ${focusResult?.reason ?? "unknown"}`,
        "input_not_found"
      );
    }

    await this.cdp.dispatchKeyEvent(
      {
        type: "keyDown",
        commands: ["selectAll"]
      },
      targetId
    );
    await this.cdp.dispatchKeyEvent(
      {
        type: "keyDown",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8
      },
      targetId
    );
    await this.cdp.dispatchKeyEvent(
      {
        type: "keyUp",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8
      },
      targetId
    );
    await this.cdp.insertText(message.text, targetId);

    const result = (await this.cdp.evaluateOnPage(
      this.buildSubmitComposerScript(),
      targetId
    )) as { ok?: boolean; reason?: string } | undefined;

    if (result?.ok) {
      return;
    }

    this.pendingReplyBaselines.delete(binding.sessionKey);
    throw new DesktopDriverError(
      `Codex desktop input box not found: ${result?.reason ?? "unknown"}`,
      "input_not_found"
    );
  }

  async collectAssistantReply(binding: DriverBinding): Promise<OutboundDraft[]> {
    const targetId = await this.ensureThreadSelected(binding);
    const baselineReply = this.pendingReplyBaselines.get(binding.sessionKey);

    for (let attempt = 0; attempt < this.replyPollAttempts; attempt += 1) {
      const reply = await this.readLatestAssistantReply(targetId);
      if (reply && (baselineReply === undefined || reply !== baselineReply)) {
        this.pendingReplyBaselines.delete(binding.sessionKey);
        return [
          {
            draftId: randomUUID(),
            sessionKey: binding.sessionKey,
            text: reply,
            createdAt: new Date().toISOString()
          }
        ];
      }

      if (attempt + 1 < this.replyPollAttempts) {
        await this.sleep(this.replyPollIntervalMs);
      }
    }

    this.pendingReplyBaselines.delete(binding.sessionKey);
    throw new DesktopDriverError(
      "Codex desktop reply did not arrive before timeout",
      "reply_timeout"
    );
  }

  async markSessionBroken(_sessionKey: string, _reason: string): Promise<void> {
    return;
  }

  private async ensureThreadSelected(binding: DriverBinding): Promise<string> {
    const targetId = await this.resolveTargetId(binding);
    const locator = binding.codexThreadRef
      ? this.decodeThreadRef(binding.codexThreadRef)
      : null;

    if (!locator) {
      return targetId;
    }

    const threads = await this.listRecentThreads(200);
    const currentThread = threads.find((thread) => thread.isCurrent);
    if (currentThread?.threadRef === binding.codexThreadRef) {
      return targetId;
    }

    const switchResult = (await this.cdp.evaluateOnPage(
      this.buildSelectThreadScript(locator),
      targetId
    )) as { ok?: boolean; reason?: string } | undefined;

    if (!switchResult?.ok) {
      throw new DesktopDriverError(
        `Codex desktop thread switch failed: ${switchResult?.reason ?? "unknown"}`,
        "session_not_found"
      );
    }

    await this.sleep(100);
    return targetId;
  }

  private async readLatestAssistantReply(targetId: string): Promise<string | null> {
    const structuredReply = await this.cdp.evaluateOnPage(
      this.buildAssistantReplyProbeScript(),
      targetId
    );
    if (
      structuredReply &&
      typeof structuredReply === "object" &&
      "reply" in structuredReply &&
      typeof structuredReply.reply === "string"
    ) {
      const normalizedReply = structuredReply.reply.trim();
      if (normalizedReply) {
        return normalizedReply;
      }
    }

    const snapshotText = await this.cdp.evaluateOnPage("document.body.innerText", targetId);
    if (typeof snapshotText !== "string") {
      throw new DesktopDriverError(
        "Codex desktop reply snapshot was not a string",
        "reply_parse_failed"
      );
    }

    const parsedReply = parseAssistantReply(snapshotText).trim();
    return parsedReply || null;
  }

  private async waitForFreshThreadContext(targetId: string): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const probe = (await this.cdp.evaluateOnPage(
        this.buildFreshThreadProbeScript(),
        targetId
      )) as { ok?: boolean } | undefined;

      if (probe?.ok) {
        return;
      }

      if (attempt + 1 < 20) {
        await this.sleep(100);
      }
    }

    throw new DesktopDriverError(
      "Codex desktop new thread did not become active",
      "session_not_found"
    );
  }

  private async resolvePageTarget() {
    const targets = await this.cdp.listTargets();
    const pageTarget = targets.find((target) => target.type === "page");

    if (!pageTarget) {
      throw new DesktopDriverError(
        "Codex desktop app is not exposing any inspectable page target",
        "session_not_found"
      );
    }

    return pageTarget;
  }

  private async resolveTargetId(binding: DriverBinding): Promise<string> {
    if (binding.codexThreadRef?.startsWith(THREAD_REF_PREFIX)) {
      const locator = this.decodeThreadRef(binding.codexThreadRef);
      if (locator) {
        return locator.pageId;
      }
    }

    if (binding.codexThreadRef?.startsWith(TARGET_REF_PREFIX)) {
      return binding.codexThreadRef.slice(TARGET_REF_PREFIX.length);
    }

    const rebound = await this.openOrBindSession(binding.sessionKey, binding);
    return this.resolveTargetId(rebound);
  }

  private encodeThreadRef(locator: ThreadLocator): string {
    const encoded = Buffer.from(
      JSON.stringify({
        title: locator.title,
        projectName: locator.projectName
      }),
      "utf8"
    ).toString("base64url");
    return `${THREAD_REF_PREFIX}${locator.pageId}:${encoded}`;
  }

  private decodeThreadRef(threadRef: string): ThreadLocator | null {
    if (!threadRef.startsWith(THREAD_REF_PREFIX)) {
      return null;
    }

    const payload = threadRef.slice(THREAD_REF_PREFIX.length);
    const separatorIndex = payload.indexOf(":");
    if (separatorIndex <= 0) {
      return null;
    }

    const pageId = payload.slice(0, separatorIndex);
    const encodedLocator = payload.slice(separatorIndex + 1);

    try {
      const locator = JSON.parse(
        Buffer.from(encodedLocator, "base64url").toString("utf8")
      ) as { title?: string; projectName?: string | null };

      if (typeof locator.title !== "string" || locator.title.trim() === "") {
        return null;
      }

      return {
        pageId,
        title: locator.title,
        projectName:
          typeof locator.projectName === "string" && locator.projectName.trim() !== ""
            ? locator.projectName
            : null
      };
    } catch {
      return null;
    }
  }

  private buildThreadListScript(limit: number): string {
    return `(() => {
      const toText = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const rows = Array.from(document.querySelectorAll('[data-thread-title="true"]'))
        .map((titleNode) => {
          if (!(titleNode instanceof HTMLElement)) {
            return null;
          }
          const row = titleNode.closest('[role="button"]');
          if (!(row instanceof HTMLElement)) {
            return null;
          }
          const projectContainer = row.closest('[role="listitem"]');
          const timeNode = row.querySelector('.text-token-description-foreground');
          return {
            title: toText(titleNode.innerText),
            projectName: projectContainer?.getAttribute('aria-label') ?? null,
            relativeTime: timeNode instanceof HTMLElement ? toText(timeNode.innerText) || null : null,
            isCurrent: row.getAttribute('aria-current') === 'page'
          };
        })
        .filter((thread) => thread && thread.title)
        .slice(0, ${limit});
      return rows;
    })();`;
  }

  private buildSelectThreadScript(locator: ThreadLocator): string {
    const expectedTitle = JSON.stringify(locator.title);
    const expectedProject = JSON.stringify(locator.projectName);
    return `(() => {
      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const target = Array.from(document.querySelectorAll('[data-thread-title="true"]'))
        .find((titleNode) => {
          if (!(titleNode instanceof HTMLElement)) {
            return false;
          }
          const row = titleNode.closest('[role="button"]');
          if (!(row instanceof HTMLElement)) {
            return false;
          }
          const projectContainer = row.closest('[role="listitem"]');
          const projectName = projectContainer?.getAttribute('aria-label') ?? null;
          return normalize(titleNode.innerText) === normalize(${expectedTitle})
            && projectName === ${expectedProject};
        });
      if (!(target instanceof HTMLElement)) {
        return { ok: false, reason: 'thread_not_found' };
      }
      const row = target.closest('[role="button"]');
      if (!(row instanceof HTMLElement)) {
        return { ok: false, reason: 'row_not_found' };
      }
      if (row.getAttribute('aria-current') === 'page') {
        return { ok: true, reason: 'already_current' };
      }
      row.focus();
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        row.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return { ok: true, reason: 'clicked_thread' };
    })();`;
  }

  private buildNewThreadScript(): string {
    return `(() => {
      const controls = Array.from(document.querySelectorAll('button, [role="button"]'));
      const button = controls.find((candidate) => {
        if (!(candidate instanceof HTMLElement)) {
          return false;
        }
        const text = (candidate.textContent || '').replace(/\\s+/g, ' ').trim();
        const aria = candidate.getAttribute('aria-label') || '';
        return text === '新线程' || aria.includes('开始新线程');
      });
      if (!(button instanceof HTMLElement)) {
        return { ok: false, reason: 'new_thread_button_not_found' };
      }
      button.focus();
      if (typeof button.click === 'function') {
        button.click();
      }
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        button.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return { ok: true, reason: 'clicked_new_thread' };
    })();`;
  }

  private buildFreshThreadProbeScript(): string {
    return `(() => {
      const composer = document.querySelector(
        '[data-codex-composer="true"], textarea, input[type="text"], [contenteditable="true"]'
      );
      const readComposerText = (node) => {
        if (!(node instanceof HTMLElement)) {
          return '';
        }
        if ('value' in node && typeof node.value === 'string') {
          return node.value;
        }
        return node.textContent || '';
      };
      const assistantUnits = document.querySelectorAll('[data-content-search-unit-key]').length;
      const composerText = readComposerText(composer).trim();
      const fresh = assistantUnits === 0 && composerText.length === 0;
      return { ok: fresh, reason: fresh ? 'fresh_thread' : 'thread_not_ready' };
    })();`;
  }

  private buildFocusComposerScript(): string {
    return `(() => {
      const selectors = [
        '[data-codex-composer="true"]',
        'textarea',
        'input[type="text"]',
        '[contenteditable="true"]',
        '[role="textbox"]'
      ];
      const input = selectors
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        .find((candidate) => {
          if (!(candidate instanceof HTMLElement)) {
            return false;
          }
          return !candidate.hasAttribute('disabled') && candidate.getAttribute('aria-disabled') !== 'true';
        });
      if (!input) {
        return { ok: false, reason: 'input_not_found' };
      }
      input.focus();
      return { ok: true, reason: 'focused_input' };
    })();`;
  }

  private buildSubmitComposerScript(): string {
    const submitButtonMatcher = isLikelyComposerSubmitButton
      .toString()
      .replace(/^function\s+isLikelyComposerSubmitButton/, "function isLikelyComposerSubmitButton");

    return `(() => {
      ${submitButtonMatcher}
      const input = document.querySelector('[data-codex-composer="true"], textarea, input[type="text"], [contenteditable="true"], [role="textbox"]');
      if (!(input instanceof HTMLElement)) {
        return { ok: false, reason: 'input_not_found' };
      }
      const form = input.closest('form');
      if (form && typeof form.requestSubmit === 'function') {
        form.requestSubmit();
        return { ok: true, reason: 'submitted_form' };
      }
      const sendButton = Array.from(document.querySelectorAll('button, [role="button"]')).find((candidate) => {
        if (!(candidate instanceof HTMLElement)) {
          return false;
        }
        return isLikelyComposerSubmitButton({
          text: candidate.textContent ?? '',
          aria: candidate.getAttribute('aria-label'),
          title: candidate.getAttribute('title'),
          className: candidate.className ?? ''
        });
      });
      if (sendButton instanceof HTMLElement) {
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          sendButton.dispatchEvent(
            new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              view: window
            })
          );
        }
        return { ok: true, reason: 'clicked_send_button' };
      }
      const keyboardEventInit = {
        bubbles: true,
        cancelable: true,
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13
      };
      input.dispatchEvent(new KeyboardEvent('keydown', keyboardEventInit));
      input.dispatchEvent(new KeyboardEvent('keypress', keyboardEventInit));
      input.dispatchEvent(new KeyboardEvent('keyup', keyboardEventInit));
      return { ok: true, reason: 'pressed_enter' };
    })();`;
  }

  private buildAssistantReplyProbeScript(): string {
    return `(() => {
      const assistantUnits = Array.from(
        document.querySelectorAll('[data-content-search-unit-key$=":assistant"]')
      );
      const latestAssistantUnit = assistantUnits.at(-1);
      if (!(latestAssistantUnit instanceof HTMLElement)) {
        return null;
      }

      const richContent = latestAssistantUnit.querySelector('[class*="_markdownContent_"]');
      if (richContent instanceof HTMLElement) {
        const text = richContent.innerText.trim();
        if (text) {
          return { reply: text };
        }
      }

      const sanitizedUnit = latestAssistantUnit.cloneNode(true);
      if (!(sanitizedUnit instanceof HTMLElement)) {
        return null;
      }
      sanitizedUnit
        .querySelectorAll('button, [role="button"], [aria-label], .text-xs')
        .forEach((node) => node.remove());
      const text = sanitizedUnit.innerText
        .split('\\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\\n')
        .trim();
      return text ? { reply: text } : null;
    })();`;
  }
}
