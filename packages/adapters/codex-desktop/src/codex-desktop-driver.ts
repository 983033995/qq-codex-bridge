import { randomUUID } from "node:crypto";
import { DesktopDriverError, type DriverBinding } from "../../../domain/src/driver.js";
import type { InboundMessage, OutboundDraft } from "../../../domain/src/message.js";
import type { DesktopDriverPort } from "../../../ports/src/conversation.js";
import { CdpSession } from "./cdp-session.js";
import { isLikelyComposerSubmitButton } from "./composer-heuristics.js";
import { parseAssistantReply } from "./reply-parser.js";

const TARGET_REF_PREFIX = "cdp-target:";

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
    const targets = await this.cdp.listTargets();
    if (binding?.codexThreadRef?.startsWith(TARGET_REF_PREFIX)) {
      const boundTargetId = binding.codexThreadRef.slice(TARGET_REF_PREFIX.length);
      const stillExists = targets.some((target) => target.id === boundTargetId && target.type === "page");
      if (stillExists) {
        return binding;
      }
    }

    const pageTarget = targets.find((target) => target.type === "page");

    if (!pageTarget) {
      throw new DesktopDriverError(
        "Codex desktop app is not exposing any inspectable page target",
        "session_not_found"
      );
    }

    return {
      sessionKey,
      codexThreadRef: `${TARGET_REF_PREFIX}${pageTarget.id}`
    };
  }

  async sendUserMessage(binding: DriverBinding, message: InboundMessage): Promise<void> {
    const targetId = await this.resolveTargetId(binding);
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
    const targetId = await this.resolveTargetId(binding);
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

  async markSessionBroken(_sessionKey: string, _reason: string): Promise<void> {
    return;
  }

  private async resolveTargetId(binding: DriverBinding): Promise<string> {
    if (binding.codexThreadRef?.startsWith(TARGET_REF_PREFIX)) {
      return binding.codexThreadRef.slice(TARGET_REF_PREFIX.length);
    }

    const rebound = await this.openOrBindSession(binding.sessionKey, binding);
    if (!rebound.codexThreadRef?.startsWith(TARGET_REF_PREFIX)) {
      throw new DesktopDriverError("Codex desktop session binding is missing a target ref", "session_not_found");
    }

    return rebound.codexThreadRef.slice(TARGET_REF_PREFIX.length);
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
