import WebSocket from "ws";

type DebugOptions = {
  remoteDebuggingPort: number;
  durationMs: number;
  prompt: string | null;
  pageOnly: boolean;
};

type TargetInfo = {
  id: string;
  title: string;
  type: string;
  url: string;
};

type AttachedTarget = {
  targetId: string;
  targetType: string;
  sessionId: string;
};

type PendingCommand = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type CapturedEvent = {
  kind: string;
  t: number;
  targetType?: string;
  targetId?: string;
  requestId?: string;
  method?: string;
  status?: number;
  mimeType?: string;
  url?: string;
  payload?: string;
  postData?: string | null;
};

class RawCdpClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly listeners = new Map<string, Array<(params: any, sessionId?: string) => void>>();

  async connect(browserWebSocketUrl: string): Promise<void> {
    const socket = new WebSocket(browserWebSocketUrl);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", (error) => reject(error));
    });

    socket.on("message", (raw) => {
      const payload = JSON.parse(String(raw));
      if (typeof payload.id === "number") {
        const pending = this.pending.get(payload.id);
        if (!pending) {
          return;
        }

        this.pending.delete(payload.id);
        if (payload.error) {
          pending.reject(new Error(JSON.stringify(payload.error)));
        } else {
          pending.resolve(payload.result);
        }
        return;
      }

      if (typeof payload.method === "string") {
        const handlers = this.listeners.get(payload.method) ?? [];
        for (const handler of handlers) {
          handler(payload.params, payload.sessionId);
        }
      }
    });

    this.socket = socket;
  }

  on(method: string, handler: (params: any, sessionId?: string) => void): void {
    const handlers = this.listeners.get(method) ?? [];
    handlers.push(handler);
    this.listeners.set(method, handlers);
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 5_000
  ): Promise<any> {
    const socket = this.socket;
    if (!socket) {
      throw new Error("CDP browser socket not connected");
    }

    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });

      const originalResolve = resolve;
      const originalReject = reject;
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          originalResolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          originalReject(error);
        }
      });
    });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2), process.env);
  const version = (await fetchJson(
    `http://127.0.0.1:${options.remoteDebuggingPort}/json/version`
  )) as { webSocketDebuggerUrl?: string };
  const browserWebSocketUrl = version.webSocketDebuggerUrl;
  if (!browserWebSocketUrl) {
    throw new Error("CDP version response missing webSocketDebuggerUrl");
  }

  const targets = (await fetchJson(
    `http://127.0.0.1:${options.remoteDebuggingPort}/json/list`
  )) as TargetInfo[];
  const page = targets.find((target) => target.type === "page");
  if (!page) {
    throw new Error("No page target found in Codex Desktop");
  }

  const client = new RawCdpClient();
  await client.connect(browserWebSocketUrl);

  const targetsToAttach = options.pageOnly ? [page] : targets;
  const attachedTargets: AttachedTarget[] = [];

  console.log(
    JSON.stringify(
      {
        discoveredTargets: targetsToAttach.map((target) => ({
          id: target.id,
          type: target.type,
          title: target.title,
          url: target.url
        })),
        monitorDurationMs: options.durationMs,
        promptRequested: Boolean(options.prompt)
      },
      null,
      2
    )
  );

  for (const target of targetsToAttach) {
    console.log(`[debug-codex-workers] attaching ${target.type}:${target.id} ...`);
    let attachResult: { sessionId?: string } | null = null;
    try {
      attachResult = (await client.send(
        "Target.attachToTarget",
        {
          targetId: target.id,
          flatten: true
        },
        undefined,
        1_500
      )) as { sessionId?: string };
    } catch (error) {
      console.warn(`[debug-codex-workers] attach failed for ${target.type}:${target.id}`, error);
      continue;
    }

    if (!attachResult?.sessionId) {
      console.warn(`[debug-codex-workers] attach returned no session for ${target.type}:${target.id}`);
      continue;
    }

    attachedTargets.push({
      targetId: target.id,
      targetType: target.type,
      sessionId: attachResult.sessionId
    });

    await client.send("Network.enable", {}, attachResult.sessionId, 800).catch((error) => {
      console.warn(`[debug-codex-workers] Network.enable failed for ${target.type}:${target.id}`, error);
    });
    await client.send("Runtime.enable", {}, attachResult.sessionId, 800).catch((error) => {
      console.warn(`[debug-codex-workers] Runtime.enable failed for ${target.type}:${target.id}`, error);
    });
  }

  const startedAt = Date.now();
  const captured: CapturedEvent[] = [];

  const lookupTarget = (sessionId?: string) =>
    attachedTargets.find((target) => target.sessionId === sessionId);

  client.on("Network.requestWillBeSent", (params, sessionId) => {
    const meta = lookupTarget(sessionId);
    captured.push({
      kind: "request",
      t: Date.now() - startedAt,
      targetType: meta?.targetType,
      targetId: meta?.targetId,
      requestId: params.requestId,
      method: params.request?.method,
      url: params.request?.url,
      postData: typeof params.request?.postData === "string"
        ? params.request.postData.slice(0, 1200)
        : null
    });
  });

  client.on("Network.responseReceived", (params, sessionId) => {
    const meta = lookupTarget(sessionId);
    captured.push({
      kind: "response",
      t: Date.now() - startedAt,
      targetType: meta?.targetType,
      targetId: meta?.targetId,
      requestId: params.requestId,
      status: params.response?.status,
      mimeType: params.response?.mimeType,
      url: params.response?.url
    });
  });

  client.on("Network.webSocketFrameReceived", (params, sessionId) => {
    const meta = lookupTarget(sessionId);
    captured.push({
      kind: "ws_in",
      t: Date.now() - startedAt,
      targetType: meta?.targetType,
      targetId: meta?.targetId,
      requestId: params.requestId,
      payload: String(params.response?.payloadData ?? "").slice(0, 1200)
    });
  });

  client.on("Network.webSocketFrameSent", (params, sessionId) => {
    const meta = lookupTarget(sessionId);
    captured.push({
      kind: "ws_out",
      t: Date.now() - startedAt,
      targetType: meta?.targetType,
      targetId: meta?.targetId,
      requestId: params.requestId,
      payload: String(params.response?.payloadData ?? "").slice(0, 1200)
    });
  });

  console.log(
    JSON.stringify(
      {
        attachedTargets,
        monitorDurationMs: options.durationMs,
        promptInjected: Boolean(options.prompt)
      },
      null,
      2
    )
  );

  if (options.prompt) {
    const pageSession = attachedTargets.find((target) => target.targetId === page.id)?.sessionId;
    if (!pageSession) {
      throw new Error("Page target was not attached");
    }
    console.log("[debug-codex-workers] injecting prompt...");
    await sendPromptThroughPage(client, pageSession, options.prompt);
    console.log("[debug-codex-workers] prompt injected");
  }

  await sleep(options.durationMs);

  const filtered = captured.filter((event) => {
    const haystack = `${event.url ?? ""}\n${event.payload ?? ""}\n${event.postData ?? ""}`;
    return /api|backend|chat|conversation|response|message|thread|openai|codex|graphql|assistant|turn/i.test(
      haystack
    );
  });

  console.log(JSON.stringify(filtered, null, 2));
}

async function sendPromptThroughPage(
  client: RawCdpClient,
  sessionId: string,
  prompt: string
): Promise<void> {
  await client.send(
    "Runtime.evaluate",
    {
      expression: `(() => {
        const input = document.querySelector('[data-codex-composer="true"], textarea, input[type="text"], [contenteditable="true"], [role="textbox"]');
        if (!(input instanceof HTMLElement)) {
          return { ok: false, reason: 'input_not_found' };
        }
        input.focus();
        return { ok: true };
      })()`,
      returnByValue: true,
      awaitPromise: true
    },
    sessionId,
    5_000
  );

  await client.send("Input.dispatchKeyEvent", { type: "keyDown", commands: ["selectAll"] }, sessionId, 5_000);
  await client.send(
    "Input.dispatchKeyEvent",
    {
      type: "keyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8
    },
    sessionId,
    5_000
  );
  await client.send(
    "Input.dispatchKeyEvent",
    {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8
    },
    sessionId,
    5_000
  );
  await client.send("Input.insertText", { text: prompt }, sessionId, 5_000);
  await client.send(
    "Runtime.evaluate",
    {
      expression: `(() => {
        const sendButton = Array.from(document.querySelectorAll('button, [role="button"]')).find((candidate) => {
          if (!(candidate instanceof HTMLElement)) {
            return false;
          }
          const rect = candidate.getBoundingClientRect();
          const label = [
            candidate.textContent || '',
            candidate.getAttribute('aria-label') || '',
            candidate.getAttribute('title') || '',
            candidate.className || ''
          ].join(' ');
          return rect.y >= window.innerHeight - 140
            && rect.x >= window.innerWidth - 120
            && /size-token-button-composer|send|发送|submit|开始构建|继续|run|resume/i.test(label);
        });
        if (!(sendButton instanceof HTMLElement)) {
          return { ok: false, reason: 'send_button_not_found' };
        }
        sendButton.click();
        return { ok: true };
      })()`,
      returnByValue: true,
      awaitPromise: true
    },
    sessionId,
    5_000
  );
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.json();
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): DebugOptions {
  let durationMs = 10_000;
  let prompt: string | null = null;
  let remoteDebuggingPort = Number(env.CODEX_REMOTE_DEBUGGING_PORT ?? 9229);
  let pageOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--duration-ms") {
      durationMs = Number(argv[index + 1] ?? durationMs);
      index += 1;
      continue;
    }
    if (current === "--prompt") {
      prompt = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (current === "--remote-debugging-port") {
      remoteDebuggingPort = Number(argv[index + 1] ?? remoteDebuggingPort);
      index += 1;
      continue;
    }
    if (current === "--page-only") {
      pageOnly = true;
    }
  }

  return {
    remoteDebuggingPort,
    durationMs: Number.isFinite(durationMs) ? durationMs : 10_000,
    prompt,
    pageOnly
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((error) => {
  console.error("[qq-codex-bridge] debug-codex-workers failed", error);
  process.exitCode = 1;
});
