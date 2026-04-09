import { randomUUID } from "node:crypto";
import { DesktopDriverError, type DriverBinding } from "../../../domain/src/driver.js";
import type { InboundMessage, OutboundDraft } from "../../../domain/src/message.js";
import type { DesktopDriverPort } from "../../../ports/src/conversation.js";
import { CdpSession } from "./cdp-session.js";
import { parseAssistantReply } from "./reply-parser.js";

const TARGET_REF_PREFIX = "cdp-target:";

export class CodexDesktopDriver implements DesktopDriverPort {
  constructor(private readonly cdp: CdpSession) {}

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
    if (binding?.codexThreadRef?.startsWith(TARGET_REF_PREFIX)) {
      return binding;
    }

    const targets = await this.cdp.listTargets();
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
    const result = (await this.cdp.evaluateOnPage(
      this.buildComposeScript(message.text),
      targetId
    )) as { ok?: boolean; reason?: string } | undefined;

    if (result?.ok) {
      return;
    }

    throw new DesktopDriverError(
      `Codex desktop input box not found: ${result?.reason ?? "unknown"}`,
      "input_not_found"
    );
  }

  async collectAssistantReply(binding: DriverBinding): Promise<OutboundDraft[]> {
    const targetId = await this.resolveTargetId(binding);
    const snapshotText = await this.cdp.evaluateOnPage("document.body.innerText", targetId);
    if (typeof snapshotText !== "string") {
      throw new DesktopDriverError(
        "Codex desktop reply snapshot was not a string",
        "reply_parse_failed"
      );
    }

    const reply = parseAssistantReply(snapshotText);
    if (!reply) {
      throw new DesktopDriverError("Codex desktop reply parser found no assistant text", "reply_parse_failed");
    }

    return [
      {
        draftId: randomUUID(),
        sessionKey: binding.sessionKey,
        text: reply,
        createdAt: new Date().toISOString()
      }
    ];
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

  private buildComposeScript(text: string): string {
    return `(() => {
      const value = ${JSON.stringify(text)};
      const selectors = [
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
      if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
        input.value = value;
      } else {
        input.textContent = value;
      }
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const form = input.closest('form');
      if (form && typeof form.requestSubmit === 'function') {
        form.requestSubmit();
        return { ok: true, reason: 'submitted_form' };
      }
      const sendButton = Array.from(document.querySelectorAll('button, [role="button"]')).find((candidate) => {
        if (!(candidate instanceof HTMLElement)) {
          return false;
        }
        const label = candidate.getAttribute('aria-label') ?? candidate.getAttribute('title') ?? candidate.textContent ?? '';
        return /send|发送|submit/i.test(label);
      });
      if (sendButton instanceof HTMLElement) {
        sendButton.click();
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
}
