import { randomUUID } from "node:crypto";
import {
  DesktopDriverError,
  type CodexThreadSummary,
  type DriverBinding
} from "../../../domain/src/driver.js";
import {
  MediaArtifactKind,
  type InboundMessage,
  type MediaArtifact,
  type OutboundDraft
} from "../../../domain/src/message.js";
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

type AssistantReplySnapshot = {
  unitKey: string | null;
  reply: string | null;
  mediaReferences: string[];
  isStreaming: boolean;
};

type CodexDesktopDriverOptions = {
  replyPollAttempts?: number;
  replyPollIntervalMs?: number;
  replyStablePolls?: number;
  sleep?: (ms: number) => Promise<void>;
};

export class CodexDesktopDriver implements DesktopDriverPort {
  private readonly replyPollAttempts: number;
  private readonly replyPollIntervalMs: number;
  private readonly replyStablePolls: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pendingReplyBaselines = new Map<string, AssistantReplySnapshot>();

  constructor(
    private readonly cdp: CdpSession,
    options: CodexDesktopDriverOptions = {}
  ) {
    this.replyPollAttempts = options.replyPollAttempts ?? 60;
    this.replyPollIntervalMs = options.replyPollIntervalMs ?? 500;
    this.replyStablePolls = Math.max(1, options.replyStablePolls ?? 3);
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
    }

    return temporaryBinding;
  }

  async sendUserMessage(binding: DriverBinding, message: InboundMessage): Promise<void> {
    const targetId = await this.ensureThreadSelected(binding);
    const baselineReply = await this.readLatestAssistantSnapshot(targetId);
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
    let candidateReply: AssistantReplySnapshot | null = null;
    let latestNewReply: AssistantReplySnapshot | null = null;
    let stablePolls = 0;

    for (let attempt = 0; attempt < this.replyPollAttempts; attempt += 1) {
      const reply = await this.readLatestAssistantSnapshot(targetId);
      const hasReplyText = typeof reply.reply === "string" && reply.reply.trim() !== "";
      const isNewReply =
        hasReplyText &&
        (baselineReply === undefined || this.isNewAssistantReply(reply, baselineReply));

      if (isNewReply) {
        latestNewReply = reply;
        if (!this.isSameAssistantReply(reply, candidateReply)) {
          candidateReply = reply;
          stablePolls = reply.isStreaming ? 0 : 1;
        } else {
          stablePolls = reply.isStreaming ? 0 : stablePolls + 1;
        }

        if (
          candidateReply?.reply &&
          !reply.isStreaming &&
          stablePolls >= this.replyStablePolls
        ) {
          this.pendingReplyBaselines.delete(binding.sessionKey);
          return [this.buildOutboundDraftFromSnapshot(binding.sessionKey, candidateReply)];
        }
      } else if (candidateReply) {
        stablePolls = 0;
      }

      if (attempt + 1 < this.replyPollAttempts) {
        await this.sleep(this.replyPollIntervalMs);
      }
    }

    this.pendingReplyBaselines.delete(binding.sessionKey);
    if (latestNewReply?.reply) {
      return [this.buildOutboundDraftFromSnapshot(binding.sessionKey, latestNewReply)];
    }

    throw new DesktopDriverError(
      "Codex desktop reply did not arrive before timeout",
      "reply_timeout"
    );
  }

  private buildOutboundDraftFromSnapshot(
    sessionKey: string,
    snapshot: AssistantReplySnapshot
  ): OutboundDraft {
    return {
      draftId: randomUUID(),
      sessionKey,
      text: snapshot.reply ?? "",
      ...(snapshot.mediaReferences.length > 0
        ? {
            mediaArtifacts: snapshot.mediaReferences.map((reference) =>
              buildMediaArtifactFromReference(reference)
            )
          }
        : {}),
      createdAt: new Date().toISOString()
    };
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

  private async readLatestAssistantSnapshot(targetId: string): Promise<AssistantReplySnapshot> {
    const structuredReply = await this.cdp.evaluateOnPage(
      this.buildAssistantReplyProbeScript(),
      targetId
    );
    if (
      structuredReply &&
      typeof structuredReply === "object" &&
      "reply" in structuredReply
    ) {
      const rawReply = structuredReply.reply;
      const normalizedReply = typeof rawReply === "string" ? rawReply.trim() : "";
      const unitKey =
        "unitKey" in structuredReply && typeof structuredReply.unitKey === "string"
          ? structuredReply.unitKey
          : null;
      const mediaReferences =
        "mediaReferences" in structuredReply && Array.isArray(structuredReply.mediaReferences)
          ? structuredReply.mediaReferences.filter(
              (reference): reference is string =>
                typeof reference === "string" && reference.trim().length > 0
            )
          : [];
      const isStreaming =
        "isStreaming" in structuredReply && typeof structuredReply.isStreaming === "boolean"
          ? structuredReply.isStreaming
          : false;
      return {
        unitKey,
        reply: normalizedReply || null,
        mediaReferences,
        isStreaming
      };
    }

    const snapshotText = await this.cdp.evaluateOnPage("document.body.innerText", targetId);
    if (typeof snapshotText !== "string") {
      throw new DesktopDriverError(
        "Codex desktop reply snapshot was not a string",
        "reply_parse_failed"
      );
    }

    const parsedReply = parseAssistantReply(snapshotText).trim();
    return {
      unitKey: null,
      reply: parsedReply || null,
      mediaReferences: [],
      isStreaming: false
    };
  }

  private isNewAssistantReply(
    current: AssistantReplySnapshot,
    baseline: AssistantReplySnapshot
  ): boolean {
    if (current.unitKey && baseline.unitKey) {
      return current.unitKey !== baseline.unitKey;
    }

    return current.reply !== baseline.reply;
  }

  private isSameAssistantReply(
    current: AssistantReplySnapshot,
    candidate: AssistantReplySnapshot | null
  ): boolean {
    if (!candidate) {
      return false;
    }

    if (current.unitKey && candidate.unitKey) {
      return (
        current.unitKey === candidate.unitKey &&
        current.reply === candidate.reply &&
        current.isStreaming === candidate.isStreaming &&
        JSON.stringify(current.mediaReferences) === JSON.stringify(candidate.mediaReferences)
      );
    }

    return (
      current.reply === candidate.reply &&
      current.isStreaming === candidate.isStreaming &&
      JSON.stringify(current.mediaReferences) === JSON.stringify(candidate.mediaReferences)
    );
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
      const normalizeReference = (value) => {
        if (!value || typeof value !== 'string') {
          return null;
        }
        if (value.startsWith('file://')) {
          try {
            return decodeURIComponent(new URL(value).pathname);
          } catch {
            return value;
          }
        }
        if (
          value.startsWith('http://') ||
          value.startsWith('https://') ||
          value.startsWith('/') ||
          value.startsWith('data:')
        ) {
          return value;
        }
        return null;
      };
      const isLocalReference = (value) =>
        typeof value === 'string' &&
        (
          value.startsWith('/') ||
          value.startsWith('./') ||
          value.startsWith('../') ||
          /^[A-Za-z]:[\\\\/]/.test(value)
        );
      const serializeRichContent = (root) => {
        const clone = root.cloneNode(true);
        if (!(clone instanceof HTMLElement)) {
          return root.innerText.trim();
        }
        clone.querySelectorAll('a[href]').forEach((link) => {
          if (!(link instanceof HTMLAnchorElement)) {
            return;
          }
          const href = normalizeReference(link.href) || link.getAttribute('href') || '';
          const text = (link.textContent || '').trim();
          const replacement = href && text && text !== href
            ? text + '\\n' + href
            : (href || text);
          link.textContent = replacement;
        });
        const serializeNode = (node, listContext) => {
          if (node instanceof HTMLBRElement) {
            return '\\n';
          }
          if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent || '';
          }
          if (!(node instanceof HTMLElement)) {
            return '';
          }

          const tagName = node.tagName;
          if (tagName === 'OL') {
            return Array.from(node.children)
              .map((child, index) => serializeNode(child, { type: 'ol', index }))
              .filter(Boolean)
              .join('\\n');
          }

          if (tagName === 'UL') {
            return Array.from(node.children)
              .map((child) => serializeNode(child, { type: 'ul' }))
              .filter(Boolean)
              .join('\\n');
          }

          if (tagName === 'LI') {
            const content = Array.from(node.childNodes)
              .map((child) => serializeNode(child, null))
              .join('')
              .replace(/\\s+\\n/g, '\\n')
              .replace(/\\n\\s+/g, '\\n')
              .replace(/[ \\t]+/g, ' ')
              .trim();
            if (!content) {
              return '';
            }
            if (listContext?.type === 'ol') {
              const index = typeof listContext.index === 'number' ? listContext.index : 0;
              return String(index + 1) + '. ' + content;
            }
            return '- ' + content;
          }

          const serializedChildren = Array.from(node.childNodes)
            .map((child) => serializeNode(child, null))
            .join('');
          if (['P', 'DIV', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'PRE'].includes(tagName)) {
            return serializedChildren.trim() ? serializedChildren.trim() + '\\n' : '';
          }
          return serializedChildren;
        };
        return serializeNode(clone, null)
          .split('\\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .join('\\n')
          .trim();
      };
      const mediaReferences = Array.from(
        latestAssistantUnit.querySelectorAll('img[src], audio[src], audio source[src], video[src], video source[src], a[href]')
      )
        .map((node) => {
          if (!(node instanceof HTMLElement)) {
            return null;
          }
          if ('src' in node && typeof node.src === 'string' && node.src) {
            return normalizeReference(node.src);
          }
          if ('href' in node && typeof node.href === 'string' && node.href) {
            const normalizedHref = normalizeReference(node.href);
            return normalizedHref && isLocalReference(normalizedHref)
              ? normalizedHref
              : null;
          }
          return null;
        })
        .filter((value, index, values) => typeof value === 'string' && values.indexOf(value) === index);
      const composer = document.querySelector(
        '[data-codex-composer="true"], textarea, input[type="text"], [contenteditable="true"], [role="textbox"]'
      );
      const composerRect = composer instanceof HTMLElement
        ? composer.getBoundingClientRect()
        : null;
      const streamingMatcher = /(\\bstop\\b|\\bthinking\\b|\\bworking\\b|\\brunning\\b|停止|中止|取消|思考中|生成中)/i;
      const isComposerBusyButton = (node) => {
        if (!(node instanceof HTMLElement)) {
          return false;
        }
        const className = String(node.className || '');
        if (!className.includes('size-token-button-composer')) {
          return false;
        }
        const html = node.innerHTML || '';
        return html.includes('M4.5 5.75C4.5 5.05964')
          || html.includes('M4.5 5.75C4.5 5.0596');
      };
      const isStreaming = Array.from(document.querySelectorAll('button, [role="button"], [aria-busy="true"]'))
        .some((node) => {
          if (!(node instanceof HTMLElement)) {
            return false;
          }
          const rect = node.getBoundingClientRect();
          const isNearComposer = composerRect
            ? rect.y >= composerRect.y - 48 && rect.y <= composerRect.bottom + 48
            : rect.y >= window.innerHeight - 160;
          if (node.getAttribute('aria-busy') === 'true') {
            return true;
          }
          if (isComposerBusyButton(node)) {
            return true;
          }
          if (!isNearComposer) {
            return false;
          }
          const label = [
            node.textContent || '',
            node.getAttribute('aria-label') || '',
            node.getAttribute('title') || ''
          ].join(' ').trim();
          return streamingMatcher.test(label);
        });

      const richContent = latestAssistantUnit.querySelector('[class*="_markdownContent_"]');
      if (richContent instanceof HTMLElement) {
        const text = serializeRichContent(richContent);
        if (text) {
          return {
            unitKey: latestAssistantUnit.getAttribute('data-content-search-unit-key'),
            reply: text,
            mediaReferences,
            isStreaming
          };
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
      return text
        ? {
            unitKey: latestAssistantUnit.getAttribute('data-content-search-unit-key'),
            reply: text,
            mediaReferences,
            isStreaming
          }
        : null;
    })();`;
  }
}

function buildMediaArtifactFromReference(reference: string): MediaArtifact {
  const normalizedReference = reference.trim();
  const strippedReference = normalizedReference.split("?")[0] ?? normalizedReference;
  const lowerReference = strippedReference.toLowerCase();
  const originalName = inferOriginalName(strippedReference);
  const mimeType = inferMimeType(lowerReference);

  return {
    kind: inferMediaArtifactKind(lowerReference, mimeType),
    sourceUrl: normalizedReference,
    localPath: normalizedReference,
    mimeType,
    fileSize: 0,
    originalName
  };
}

function inferMediaArtifactKind(reference: string, mimeType: string): MediaArtifactKind {
  if (mimeType.startsWith("image/") || /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(reference)) {
    return MediaArtifactKind.Image;
  }

  if (mimeType.startsWith("audio/") || /\.(mp3|wav|ogg|aac|flac|silk)$/i.test(reference)) {
    return MediaArtifactKind.Audio;
  }

  if (mimeType.startsWith("video/") || /\.(mp4|mov|avi|mkv|webm)$/i.test(reference)) {
    return MediaArtifactKind.Video;
  }

  return MediaArtifactKind.File;
}

function inferMimeType(reference: string): string {
  if (reference.startsWith("data:image/")) {
    const match = reference.match(/^data:(image\/[^;]+);/i);
    return match?.[1] ?? "image/png";
  }

  if (/\.png$/i.test(reference)) return "image/png";
  if (/\.(jpg|jpeg)$/i.test(reference)) return "image/jpeg";
  if (/\.gif$/i.test(reference)) return "image/gif";
  if (/\.webp$/i.test(reference)) return "image/webp";
  if (/\.bmp$/i.test(reference)) return "image/bmp";
  if (/\.mp3$/i.test(reference)) return "audio/mpeg";
  if (/\.wav$/i.test(reference)) return "audio/wav";
  if (/\.ogg$/i.test(reference)) return "audio/ogg";
  if (/\.aac$/i.test(reference)) return "audio/aac";
  if (/\.flac$/i.test(reference)) return "audio/flac";
  if (/\.silk$/i.test(reference)) return "audio/silk";
  if (/\.mp4$/i.test(reference)) return "video/mp4";
  if (/\.mov$/i.test(reference)) return "video/quicktime";
  if (/\.avi$/i.test(reference)) return "video/x-msvideo";
  if (/\.mkv$/i.test(reference)) return "video/x-matroska";
  if (/\.webm$/i.test(reference)) return "video/webm";
  if (/\.pdf$/i.test(reference)) return "application/pdf";
  return "application/octet-stream";
}

function inferOriginalName(reference: string): string {
  try {
    if (reference.startsWith("data:image/")) {
      return "codex-inline-image";
    }

    const url = reference.startsWith("http://") || reference.startsWith("https://")
      ? new URL(reference)
      : null;
    const pathname = url?.pathname ?? reference;
    const segments = pathname.split("/");
    return segments.at(-1) || "codex-media";
  } catch {
    const segments = reference.split("/");
    return segments.at(-1) || "codex-media";
  }
}
