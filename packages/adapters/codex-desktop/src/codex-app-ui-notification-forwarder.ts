import { CdpSession } from "./cdp-session.js";

export type CodexAppUiNotification = {
  method: string;
  params?: unknown;
};

type CodexDesktopAppUiNotificationForwarderOptions = {
  hostId?: string;
};

export class CodexDesktopAppUiNotificationForwarder {
  private readonly hostId: string;

  constructor(
    private readonly cdp: CdpSession,
    options: CodexDesktopAppUiNotificationForwarderOptions = {}
  ) {
    this.hostId = options.hostId ?? "local";
  }

  async forwardNotification(method: string, params: unknown): Promise<void> {
    await this.cdp.connect();
    await this.cdp.evaluateOnPage(
      buildCodexAppNotificationDispatchScript({
        hostId: this.hostId,
        method,
        params
      })
    );
  }
}

export function buildCodexAppNotificationDispatchScript(notification: {
  hostId: string;
  method: string;
  params: unknown;
}): string {
  const payloadJson = JSON.stringify({
    type: "mcp-notification",
    hostId: notification.hostId,
    method: notification.method,
    params: notification.params
  });

  return `(() => {
    const payload = JSON.parse(${JSON.stringify(payloadJson)});
    window.dispatchEvent(new MessageEvent("message", {
      data: payload,
      origin: window.location.origin,
      source: window
    }));
    return true;
  })()`;
}
