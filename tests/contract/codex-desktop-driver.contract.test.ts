import { describe, expect, it, vi } from "vitest";
import { DesktopDriverError } from "../../packages/domain/src/driver.js";
import {
  TurnEventType,
  type OutboundDraft,
  type TurnEvent
} from "../../packages/domain/src/message.js";
import { CodexDesktopDriver } from "../../packages/adapters/codex-desktop/src/codex-desktop-driver.js";
import { parseAssistantReply } from "../../packages/adapters/codex-desktop/src/reply-parser.js";
import type { CdpSession } from "../../packages/adapters/codex-desktop/src/cdp-session.js";

class FakeControlElement {
  textContent: string;
  className: string;
  private readonly attrs: Record<string, string>;
  private readonly rect: { x: number; y: number; width: number; height: number };
  private readonly onClick?: () => void;

  constructor(options: {
    text?: string;
    aria?: string;
    title?: string;
    className?: string;
    rect: { x: number; y: number; width?: number; height?: number };
    onClick?: () => void;
  }) {
    this.textContent = options.text ?? "";
    this.className = options.className ?? "";
    this.attrs = {};
    if (options.aria) {
      this.attrs["aria-label"] = options.aria;
    }
    if (options.title) {
      this.attrs.title = options.title;
    }
    this.rect = {
      x: options.rect.x,
      y: options.rect.y,
      width: options.rect.width ?? 80,
      height: options.rect.height ?? 28
    };
    this.onClick = options.onClick;
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  get innerText(): string {
    return this.textContent;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  dispatchEvent(event: { type?: string }) {
    if (event?.type === "click") {
      this.onClick?.();
    }
    return true;
  }
}

class FakeMouseEvent {
  constructor(public readonly type: string) {}
}

class FakeHtmlElement {
  readonly tagName: string;
  className: string;
  textContent: string;
  innerHTML: string;
  childNodes: Array<FakeHtmlElement | { nodeType: number; textContent: string }>;
  private readonly attrs: Record<string, string>;
  private readonly rect: {
    x: number;
    y: number;
    width: number;
    height: number;
    top: number;
    bottom: number;
    left: number;
    right: number;
  };
  private readonly selectorMap: Map<string, FakeHtmlElement[]>;

  constructor(options: {
    tagName?: string;
    className?: string;
    textContent?: string;
    innerHTML?: string;
    attrs?: Record<string, string>;
    rect: { x: number; y: number; width: number; height: number };
    selectorMap?: Map<string, FakeHtmlElement[]>;
  }) {
    this.tagName = options.tagName ?? "DIV";
    this.className = options.className ?? "";
    this.textContent = options.textContent ?? "";
    this.innerHTML = options.innerHTML ?? "";
    this.childNodes = options.textContent
      ? [{ nodeType: 3, textContent: options.textContent }]
      : [];
    this.attrs = { ...(options.attrs ?? {}) };
    this.rect = {
      x: options.rect.x,
      y: options.rect.y,
      width: options.rect.width,
      height: options.rect.height,
      top: options.rect.y,
      bottom: options.rect.y + options.rect.height,
      left: options.rect.x,
      right: options.rect.x + options.rect.width
    };
    this.selectorMap = options.selectorMap ?? new Map();
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  hasAttribute(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.attrs, name);
  }

  querySelector(selector: string): FakeHtmlElement | null {
    return this.selectorMap.get(selector)?.[0] ?? null;
  }

  querySelectorAll(selector: string): FakeHtmlElement[] {
    return this.selectorMap.get(selector) ?? [];
  }

  getBoundingClientRect() {
    return this.rect;
  }

  get innerText(): string {
    return this.textContent;
  }

  focus(): void {}

  closest(): null {
    return null;
  }

  click(): void {
    this.dispatchEvent({ type: "click" });
  }

  dispatchEvent(event: { type?: string }): boolean {
    void event;
    return true;
  }

  cloneNode(): FakeHtmlElement {
    const clone = new FakeHtmlElement({
      tagName: this.tagName,
      className: this.className,
      textContent: this.textContent,
      innerHTML: this.innerHTML,
      attrs: this.attrs,
      rect: this.rect,
      selectorMap: this.selectorMap
    });
    clone.childNodes = [...this.childNodes];
    return clone;
  }
}

describe("codex desktop driver contract", () => {
  it("extracts the latest assistant reply from a snapshot string", () => {
    const reply = parseAssistantReply(`
      User: hello
      Assistant: first reply
      Assistant: latest reply
    `);

    expect(reply).toBe("latest reply");
  });

  it("assistant reply probe prefers the visible tail reply over offscreen historical units", () => {
    const driver = new CodexDesktopDriver({} as unknown as CdpSession);
    const probeScript = (driver as unknown as { buildAssistantReplyProbeScript: () => string })
      .buildAssistantReplyProbeScript();

    const visibleRichContent = new FakeHtmlElement({
      className: "_markdownContent_visible",
      textContent: "当前可见的新回复",
      rect: { x: 0, y: 0, width: 200, height: 80 }
    });
    const visibleAssistant = new FakeHtmlElement({
      attrs: { "data-content-search-unit-key": "assistant-visible:0:assistant" },
      rect: { x: 420, y: 520, width: 736, height: 180 },
      textContent: "当前可见的新回复",
      selectorMap: new Map([
        ['[class*="_markdownContent_"]', [visibleRichContent]],
        ['img[src], audio[src], audio source[src], video[src], video source[src], a[href]', []],
        ['.text-xs, [aria-live], [data-state], [class*="status"], [class*="loading"]', []]
      ])
    });
    const staleFarBelow = new FakeHtmlElement({
      attrs: { "data-content-search-unit-key": "assistant-stale:0:assistant" },
      rect: { x: 420, y: 2234, width: 736, height: 180 },
      textContent: "更旧的历史回复，不该被拿到",
      selectorMap: new Map([
        ['[class*="_markdownContent_"]', []],
        ['img[src], audio[src], audio source[src], video[src], video source[src], a[href]', []],
        ['.text-xs, [aria-live], [data-state], [class*="status"], [class*="loading"]', []]
      ])
    });
    const composer = new FakeHtmlElement({
      className: "ProseMirror",
      rect: { x: 430, y: 799, width: 712, height: 40 }
    });

    const originalWindow = (globalThis as Record<string, unknown>).window;
    const originalDocument = (globalThis as Record<string, unknown>).document;
    const originalHTMLElement = (globalThis as Record<string, unknown>).HTMLElement;
    const originalHTMLAnchorElement = (globalThis as Record<string, unknown>).HTMLAnchorElement;
    const originalHTMLBRElement = (globalThis as Record<string, unknown>).HTMLBRElement;
    const originalNode = (globalThis as Record<string, unknown>).Node;

    (globalThis as Record<string, unknown>).window = { innerHeight: 900 };
    (globalThis as Record<string, unknown>).document = {
      querySelectorAll: (selector: string) => {
        if (selector === '[data-content-search-unit-key$=":assistant"]') {
          return [visibleAssistant, staleFarBelow];
        }
        if (selector === 'button, [role="button"], [aria-busy="true"]') {
          return [];
        }
        return [];
      },
      querySelector: (selector: string) => {
        if (selector === '[data-codex-composer="true"], textarea, input[type="text"], [contenteditable="true"], [role="textbox"]') {
          return composer;
        }
        return null;
      }
    };
    (globalThis as Record<string, unknown>).HTMLElement = FakeHtmlElement;
    (globalThis as Record<string, unknown>).HTMLAnchorElement = FakeHtmlElement;
    (globalThis as Record<string, unknown>).HTMLBRElement = class FakeBrElement extends FakeHtmlElement {};
    (globalThis as Record<string, unknown>).Node = { TEXT_NODE: 3 };

    try {
      const result = eval(probeScript) as { unitKey?: string; reply?: string | null; isStreaming?: boolean } | null;
      expect(result).toMatchObject({
        unitKey: "assistant-visible:0:assistant",
        reply: "当前可见的新回复",
        isStreaming: false
      });
    } finally {
      (globalThis as Record<string, unknown>).window = originalWindow;
      (globalThis as Record<string, unknown>).document = originalDocument;
      (globalThis as Record<string, unknown>).HTMLElement = originalHTMLElement;
      (globalThis as Record<string, unknown>).HTMLAnchorElement = originalHTMLAnchorElement;
      (globalThis as Record<string, unknown>).HTMLBRElement = originalHTMLBRElement;
      (globalThis as Record<string, unknown>).Node = originalNode;
    }
  });

  it("submit composer script only triggers the send button once", async () => {
    const driver = new CodexDesktopDriver({} as unknown as CdpSession);
    const submitScript = (driver as unknown as { buildSubmitComposerScript: () => string })
      .buildSubmitComposerScript();

    let submitCount = 0;
    const composer = new FakeHtmlElement({
      className: "ProseMirror",
      textContent: "测试消息",
      rect: { x: 430, y: 799, width: 712, height: 40 }
    });
    const sendButton = new FakeHtmlElement({
      className: "focus-visible:outline-token-button-background cursor-interaction size-token-button-composer flex items-center justify-center rounded-full p-0.5 transition-opacity focus-visible:outline-2 bg-token-foreground",
      rect: { x: 1122, y: 847, width: 28, height: 28 }
    });
    sendButton.dispatchEvent = (event: { type?: string }) => {
      if (event?.type === "click") {
        submitCount += 1;
      }
      return true;
    };

    const originalWindow = (globalThis as Record<string, unknown>).window;
    const originalDocument = (globalThis as Record<string, unknown>).document;
    const originalHTMLElement = (globalThis as Record<string, unknown>).HTMLElement;
    const originalMouseEvent = (globalThis as Record<string, unknown>).MouseEvent;

    (globalThis as Record<string, unknown>).window = {
      setTimeout: (fn: () => unknown) => {
        fn();
        return 0;
      }
    };
    (globalThis as Record<string, unknown>).document = {
      activeElement: composer,
      querySelectorAll: (selector: string) => {
        if (
          selector === '[data-codex-composer="true"]'
          || selector === "textarea"
          || selector === 'input[type="text"]'
          || selector === '[contenteditable="true"]'
          || selector === '[role="textbox"]'
        ) {
          return [composer];
        }
        if (selector === "button, [role=\"button\"]") {
          return [sendButton];
        }
        if (selector === "[data-content-search-unit-key]") {
          return [];
        }
        return [];
      }
    };
    (globalThis as Record<string, unknown>).HTMLElement = FakeHtmlElement;
    (globalThis as Record<string, unknown>).MouseEvent = FakeMouseEvent;

    try {
      const result = (await eval(submitScript)) as { ok?: boolean; reason?: string };
      expect(result).toMatchObject({ ok: false, reason: "submit_not_confirmed" });
      expect(submitCount).toBe(1);
    } finally {
      (globalThis as Record<string, unknown>).window = originalWindow;
      (globalThis as Record<string, unknown>).document = originalDocument;
      (globalThis as Record<string, unknown>).HTMLElement = originalHTMLElement;
      (globalThis as Record<string, unknown>).MouseEvent = originalMouseEvent;
    }
  });

  it("fails readiness when no inspectable page target exists", async () => {
    const driver = new CodexDesktopDriver({
      connect: vi.fn().mockResolvedValue({
        appName: "Codex",
        browserVersion: "Codex/1.0",
        browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
      }),
      listTargets: vi.fn().mockResolvedValue([])
    } as unknown as CdpSession);

    await expect(driver.ensureAppReady()).rejects.toEqual(
      new DesktopDriverError("Codex desktop app is not exposing any inspectable page target", "app_not_ready")
    );
  });

  it("binds a session to the first inspectable page target", async () => {
    const driver = new CodexDesktopDriver({
      connect: vi.fn().mockResolvedValue({
        appName: "Codex",
        browserVersion: "Codex/1.0",
        browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
      }),
      listTargets: vi.fn().mockResolvedValue([
        {
          id: "page-1",
          title: "Codex",
          type: "page",
          url: "app://codex"
        }
      ]),
      evaluateOnPage: vi.fn().mockResolvedValue([
        {
          title: "线程 A",
          projectName: "skills",
          relativeTime: "2 小时",
          isCurrent: true
        }
      ])
    } as unknown as CdpSession);

    await expect(driver.openOrBindSession("qqbot:default::qq:c2c:OPENID123", null)).resolves.toEqual({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: expect.stringContaining("codex-thread:page-1:")
    });
  });

  it("preserves an existing target binding instead of rebinding to a stale sidebar thread", async () => {
    const driver = new CodexDesktopDriver({
      connect: vi.fn().mockResolvedValue({
        appName: "Codex",
        browserVersion: "Codex/1.0",
        browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
      }),
      listTargets: vi.fn().mockResolvedValue([
        {
          id: "page-1",
          title: "Codex",
          type: "page",
          url: "app://codex"
        }
      ]),
      evaluateOnPage: vi.fn().mockResolvedValue([
        {
          title: "旧线程",
          projectName: "skills",
          relativeTime: "刚刚",
          isCurrent: true
        }
      ])
    } as unknown as CdpSession);

    await expect(
      driver.openOrBindSession("qqbot:default::qq:c2c:OPENID123", {
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        codexThreadRef: "cdp-target:page-1"
      })
    ).resolves.toEqual({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "cdp-target:page-1"
    });
  });

  it("lists recent real codex sidebar threads from the current desktop ui", async () => {
    const evaluateOnPage = vi.fn().mockResolvedValue([
      {
        title: "线程 B",
        projectName: "Desktop",
        relativeTime: "1 天",
        isCurrent: false
      },
      {
        title: "线程 A",
        projectName: "skills",
        relativeTime: "2 小时",
        isCurrent: true
      },
      {
        title: "线程 C",
        projectName: "skills",
        relativeTime: "15 分钟",
        isCurrent: false
      }
    ]);

    const driver = new CodexDesktopDriver({
      connect: vi.fn().mockResolvedValue({
        appName: "Codex",
        browserVersion: "Codex/1.0",
        browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
      }),
      listTargets: vi.fn().mockResolvedValue([
        {
          id: "page-1",
          title: "Codex",
          type: "page",
          url: "app://codex"
        }
      ]),
      evaluateOnPage
    } as unknown as CdpSession);

    await expect(driver.listRecentThreads(20)).resolves.toEqual([
      {
        index: 1,
        title: "线程 C",
        projectName: "skills",
        relativeTime: "15 分钟",
        isCurrent: false,
        threadRef: expect.stringContaining("codex-thread:page-1:")
      },
      {
        index: 2,
        title: "线程 A",
        projectName: "skills",
        relativeTime: "2 小时",
        isCurrent: true,
        threadRef: expect.stringContaining("codex-thread:page-1:")
      },
      {
        index: 3,
        title: "线程 B",
        projectName: "Desktop",
        relativeTime: "1 天",
        isCurrent: false,
        threadRef: expect.stringContaining("codex-thread:page-1:")
      }
    ]);
    expect(evaluateOnPage).toHaveBeenCalledWith(
      expect.stringContaining("data-thread-title"),
      "page-1"
    );
  });

  it("switches a qq session binding to a selected codex sidebar thread", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce([
        {
          title: "线程 A",
          projectName: "skills",
          relativeTime: "2 小时",
          isCurrent: false
        },
        {
          title: "线程 B",
          projectName: "skills",
          relativeTime: "1 天",
          isCurrent: true
        }
      ])
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce([
        {
          title: "线程 A",
          projectName: "skills",
          relativeTime: "刚刚",
          isCurrent: true
        },
        {
          title: "线程 B",
          projectName: "skills",
          relativeTime: "1 天",
          isCurrent: false
        }
      ]);

    const driver = new CodexDesktopDriver({
      connect: vi.fn().mockResolvedValue({
        appName: "Codex",
        browserVersion: "Codex/1.0",
        browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
      }),
      listTargets: vi.fn().mockResolvedValue([
        {
          id: "page-1",
          title: "Codex",
          type: "page",
          url: "app://codex"
        }
      ]),
      evaluateOnPage
    } as unknown as CdpSession);

    const threads = await driver.listRecentThreads(20);
    await expect(
      driver.switchToThread("qqbot:default::qq:c2c:OPENID123", threads[0].threadRef)
    ).resolves.toEqual({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: threads[0].threadRef
    });
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("clicked_thread"),
      "page-1"
    );
  });

  it("creates a new thread only after a fresh thread context becomes active and keeps a target binding", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, reason: "clicked_new_thread" })
      .mockResolvedValueOnce({ ok: true, reason: "fresh_thread" });

    const driver = new CodexDesktopDriver(
      {
        connect: vi.fn().mockResolvedValue({
          appName: "Codex",
          browserVersion: "Codex/1.0",
          browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
        }),
        listTargets: vi.fn().mockResolvedValue([
          {
            id: "page-1",
            title: "Codex",
            type: "page",
            url: "app://codex"
          }
        ]),
        evaluateOnPage
      } as unknown as CdpSession,
      {
        replyPollIntervalMs: 0,
        sleep: async () => undefined
      }
    );

    await expect(
      driver.createThread("qqbot:default::qq:c2c:OPENID123", "")
    ).resolves.toEqual({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "cdp-target:page-1"
    });
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("fresh_thread"),
      "page-1"
    );
  });

  it("reads model, quota and runtime controls from the current desktop ui", async () => {
    const evaluateOnPage = vi.fn().mockResolvedValue({
      model: "GPT-5.4",
      reasoningEffort: "高",
      workspace: "本地工作",
      branch: "codex/qq-codex-bridge",
      permissionMode: "完全访问权限",
      quotaSummary: "5 小时 55%（20:14 重置）\n1 周 68%（4月22日 重置）"
    });

    const driver = new CodexDesktopDriver({
      connect: vi.fn().mockResolvedValue({
        appName: "Codex",
        browserVersion: "Codex/1.0",
        browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
      }),
      listTargets: vi.fn().mockResolvedValue([
        {
          id: "page-1",
          title: "Codex",
          type: "page",
          url: "app://codex"
        }
      ]),
      evaluateOnPage
    } as unknown as CdpSession);

    await expect(driver.getControlState()).resolves.toEqual({
      model: "GPT-5.4",
      reasoningEffort: "高",
      workspace: "本地工作",
      branch: "codex/qq-codex-bridge",
      permissionMode: "完全访问权限",
      quotaSummary: "5 小时 55%（20:14 重置）\n1 周 68%（4月22日 重置）"
    });
    expect(evaluateOnPage).toHaveBeenCalledWith(
      expect.stringContaining("quotaSummary"),
      "page-1"
    );
  });

  it("ignores injected runtime context when deriving quota summary", async () => {
    const driver = new CodexDesktopDriver({} as unknown as CdpSession);
    const script = (driver as unknown as { buildReadControlStateScript: () => string }).buildReadControlStateScript();
    const execute = new Function(
      "document",
      "window",
      "HTMLElement",
      "MouseEvent",
      "setTimeout",
      `return (${script});`
    ) as (
      document: {
        querySelectorAll: (selector: string) => FakeControlElement[];
        body: { innerText: string };
      },
      window: { innerHeight: number },
      HTMLElement: typeof FakeControlElement,
      MouseEvent: typeof FakeMouseEvent,
      setTimeout: (fn: () => void, delay?: number) => number
    ) => Promise<{
      model: string | null;
      reasoningEffort: string | null;
      workspace: string | null;
      branch: string | null;
      permissionMode: string | null;
      quotaSummary: string | null;
    }>;

    const state = await execute(
      {
        querySelectorAll: () => [
          new FakeControlElement({ text: "GPT-5.4", className: "h-token-button-composer", rect: { x: 460, y: 740 } }),
          new FakeControlElement({ text: "高", className: "h-token-button-composer", rect: { x: 560, y: 740 } }),
          new FakeControlElement({ text: "本地工作", className: "h-token-button-composer-sm", rect: { x: 620, y: 740 } }),
          new FakeControlElement({ text: "完全访问权限", className: "h-token-button-composer-sm", rect: { x: 870, y: 740 } })
        ],
        body: {
          innerText:
            "GPT-5.4\n高\n本地工作\n完全访问权限\n<!-- QQBOT_RUNTIME_CONTEXT 会话类型：QQ 私聊 给 QQ 用户发图片、语音、视频、文件时，必须输出 <qqmedia>绝对路径或URL</qqmedia>。大小限制：图片 30MB、语音 20MB、视频/文件 100MB。 -->"
        }
      },
      { innerHeight: 800 },
      FakeControlElement,
      FakeMouseEvent,
      (fn) => {
        fn();
        return 0;
      }
    );

    expect(state).toMatchObject({
      model: "GPT-5.4",
      reasoningEffort: "高",
      workspace: "本地工作",
      branch: null,
      permissionMode: "完全访问权限",
      quotaSummary: null
    });
  });

  it("reads control state and quota summary from the new local workspace dropdown", async () => {
    const driver = new CodexDesktopDriver({} as unknown as CdpSession);
    const controlScript = (driver as unknown as { buildReadControlStateScript: () => string }).buildReadControlStateScript();
    const quotaScript = (driver as unknown as { buildReadQuotaSummaryScript: () => string }).buildReadQuotaSummaryScript();
    const executeControl = new Function(
      "document",
      "window",
      "HTMLElement",
      "MouseEvent",
      "setTimeout",
      `return (${controlScript});`
    ) as (
      document: {
        querySelectorAll: (selector: string) => FakeControlElement[];
        body: { innerText: string };
      },
      window: { innerHeight: number },
      HTMLElement: typeof FakeControlElement,
      MouseEvent: typeof FakeMouseEvent,
      setTimeout: (fn: () => void, delay?: number) => number
    ) => Promise<{
      model: string | null;
      reasoningEffort: string | null;
      workspace: string | null;
      branch: string | null;
      permissionMode: string | null;
      quotaSummary: string | null;
    }>;
    const execute = new Function(
      "document",
      "window",
      "HTMLElement",
      "MouseEvent",
      `return (${quotaScript});`
    ) as (
      document: {
        querySelectorAll: (selector: string) => FakeControlElement[];
        body: { innerText: string };
      },
      window: { innerHeight: number },
      HTMLElement: typeof FakeControlElement,
      MouseEvent: typeof FakeMouseEvent
    ) => Promise<string | null>;

    const uiState = {
      menuOpen: false,
      quotaExpanded: false
    };
    const document = {
      querySelectorAll: () => {
        const controls = [
          new FakeControlElement({
            text: "GPT-5.4",
            className: "h-token-button-composer",
            rect: { x: 920, y: 740, width: 90 }
          }),
          new FakeControlElement({
            text: "中",
            className: "h-token-button-composer",
            rect: { x: 1018, y: 740, width: 48 }
          }),
          new FakeControlElement({
            text: "完全访问权限",
            className: "h-token-button-composer-sm",
            rect: { x: 450, y: 740, width: 124 }
          }),
          new FakeControlElement({
            text: "本地工作",
            className: "h-token-button-composer-sm",
            rect: { x: 430, y: 740, width: 98 },
            onClick: () => {
              uiState.menuOpen = !uiState.menuOpen;
            }
          }),
          new FakeControlElement({
            text: "codex/weixin-multi-channel",
            className: "h-token-button-composer-sm",
            rect: { x: 536, y: 740, width: 206 }
          }),
          new FakeControlElement({
            text: "调试命令输出，不应该影响底栏识别",
            className: "cursor-interaction",
            rect: { x: 431, y: 1021, width: 694, height: 36 }
          }),
          new FakeControlElement({
            aria: "复制",
            className: "absolute top-0 right-0",
            rect: { x: 1125, y: 1057, width: 24, height: 24 }
          })
        ];

        if (uiState.menuOpen) {
          controls.push(
            new FakeControlElement({
              text: "在本地处理",
              rect: { x: 150, y: 490, width: 180, height: 30 }
            }),
            new FakeControlElement({
              text: "codex/stale-branch-from-menu",
              rect: { x: 150, y: 530, width: 180, height: 30 }
            }),
            new FakeControlElement({
              text: "剩余额度",
              rect: { x: 140, y: 520 },
              onClick: () => {
                uiState.quotaExpanded = true;
              }
            })
          );
        }

        return controls;
      },
      body: {
        get innerText() {
          if (!uiState.menuOpen) {
            return "GPT-5.4\n中\n完全访问权限\n本地工作";
          }
          if (!uiState.quotaExpanded) {
            return "继续使用\n在本地处理\ncodex/qq-codex-bridge\n剩余额度\n升级至 Pro\n了解更多";
          }
          return "继续使用\n在本地处理\ncodex/qq-codex-bridge\n剩余额度\n5 小时\n55%\n20:14\n1 周\n68%\n4月22日\n升级至 Pro\n了解更多";
        }
      }
    };

    await expect(
      executeControl(
        document,
        { innerHeight: 800 },
        FakeControlElement,
        FakeMouseEvent,
        (fn) => {
          fn();
          return 0;
        }
      )
    ).resolves.toEqual({
      model: "GPT-5.4",
      reasoningEffort: "中",
      workspace: "本地工作",
      branch: "codex/weixin-multi-channel",
      permissionMode: "完全访问权限",
      quotaSummary: "5 小时 55%（20:14 重置）\n1 周 68%（4月22日 重置）"
    });

    await expect(
      execute(document, { innerHeight: 800 }, FakeControlElement, FakeMouseEvent)
    ).resolves.toBe("5 小时 55%（20:14 重置）\n1 周 68%（4月22日 重置）");
  });

  it("switches model from the current desktop ui and returns refreshed control state", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        model: "GPT-5.4-Mini",
        reasoningEffort: "高",
        workspace: "本地",
        branch: "codex/qq-codex-bridge",
        permissionMode: "完全访问权限",
        quotaSummary: null
      });

    const driver = new CodexDesktopDriver(
      {
        connect: vi.fn().mockResolvedValue({
          appName: "Codex",
          browserVersion: "Codex/1.0",
          browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
        }),
        listTargets: vi.fn().mockResolvedValue([
          {
            id: "page-1",
            title: "Codex",
            type: "page",
            url: "app://codex"
          }
        ]),
        evaluateOnPage
      } as unknown as CdpSession,
      {
        sleep: async () => undefined
      }
    );

    await expect(driver.switchModel("GPT-5.4-Mini")).resolves.toEqual({
      model: "GPT-5.4-Mini",
      reasoningEffort: "高",
      workspace: "本地",
      branch: "codex/qq-codex-bridge",
      permissionMode: "完全访问权限",
      quotaSummary: null
    });
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("model_option_not_found"),
      "page-1"
    );
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("quotaSummary"),
      "page-1"
    );
  });

  it("does not fail thread creation when the seed prompt does not produce an assistant reply", async () => {
    const dispatchKeyEvent = vi.fn().mockResolvedValue(undefined);
    const insertText = vi.fn().mockResolvedValue(undefined);
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, reason: "clicked_new_thread" })
      .mockResolvedValueOnce({ ok: true, reason: "fresh_thread" })
      .mockResolvedValueOnce({ reply: null })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" });

    const driver = new CodexDesktopDriver(
      {
        connect: vi.fn().mockResolvedValue({
          appName: "Codex",
          browserVersion: "Codex/1.0",
          browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
        }),
        listTargets: vi.fn().mockResolvedValue([
          {
            id: "page-1",
            title: "Codex",
            type: "page",
            url: "app://codex"
          }
        ]),
        evaluateOnPage,
        dispatchKeyEvent,
        insertText
      } as unknown as CdpSession,
      {
        replyPollIntervalMs: 0,
        sleep: async () => undefined
      }
    );

    await expect(
      driver.createThread("qqbot:default::qq:c2c:OPENID123", "线程标题：测试新线程")
    ).resolves.toEqual({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "cdp-target:page-1"
    });
    expect(insertText).toHaveBeenCalledWith("线程标题：测试新线程", "page-1");
  });

  it("waits for the bound thread to become current before sending the user message", async () => {
    const dispatchKeyEvent = vi.fn().mockResolvedValue(undefined);
    const insertText = vi.fn().mockResolvedValue(undefined);
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce([
        {
          title: "绑定线程",
          projectName: "桌面",
          relativeTime: "2 小时",
          isCurrent: false
        },
        {
          title: "当前线程",
          projectName: "桌面",
          relativeTime: "刚刚",
          isCurrent: true
        }
      ])
      .mockResolvedValueOnce({
        latestUnitKey: "old-thread:last-unit",
        latestSnippet: "旧线程最后一条消息",
        unitCount: 12
      })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_thread" })
      .mockResolvedValueOnce([
        {
          title: "绑定线程",
          projectName: "桌面",
          relativeTime: "2 小时",
          isCurrent: false
        },
        {
          title: "当前线程",
          projectName: "桌面",
          relativeTime: "刚刚",
          isCurrent: true
        }
      ])
      .mockResolvedValueOnce({
        latestUnitKey: "old-thread:last-unit",
        latestSnippet: "旧线程最后一条消息",
        unitCount: 12
      })
      .mockResolvedValueOnce([
        {
          title: "绑定线程",
          projectName: "桌面",
          relativeTime: "刚刚",
          isCurrent: true
        },
        {
          title: "当前线程",
          projectName: "桌面",
          relativeTime: "2 小时",
          isCurrent: false
        }
      ])
      .mockResolvedValueOnce({
        latestUnitKey: "bound-thread:last-unit",
        latestSnippet: "绑定线程上一条消息",
        unitCount: 8
      })
      .mockResolvedValueOnce({ unitKey: "assistant-before", reply: "目标线程旧回复" })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" });

    const driver = new CodexDesktopDriver(
      {
        connect: vi.fn().mockResolvedValue({
          appName: "Codex",
          browserVersion: "Codex/1.0",
          browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
        }),
        listTargets: vi.fn().mockResolvedValue([
          {
            id: "page-1",
            title: "Codex",
            type: "page",
            url: "app://codex"
          }
        ]),
        evaluateOnPage,
        dispatchKeyEvent,
        insertText
      } as unknown as CdpSession,
      {
        sleep: async () => undefined
      }
    );

    await expect(
      driver.sendUserMessage(
        {
          sessionKey: "weixin:default::wx:c2c:OPENID123",
          codexThreadRef:
            "codex-thread:page-1:eyJ0aXRsZSI6Iue7keWumue6v-eoiyIsInByb2plY3ROYW1lIjoi5qGM6Z2iIn0"
        },
        {
          messageId: "msg-thread-switch",
          accountKey: "weixin:default",
          sessionKey: "weixin:default::wx:c2c:OPENID123",
          peerKey: "wx:c2c:OPENID123",
          chatType: "c2c",
          senderId: "OPENID123",
          text: "切到绑定线程后再发",
          receivedAt: "2026-04-17T12:00:00.000Z"
        }
      )
    ).resolves.toBeUndefined();

    expect(
      evaluateOnPage.mock.calls.some(
        (call) =>
          typeof call?.[0] === "string"
          && call[0].includes("latestUnitKey")
          && call[1] === "page-1"
      )
    ).toBe(true);
    expect(insertText).toHaveBeenCalledWith("切到绑定线程后再发", "page-1");
  });

  it("retries composer submission with Enter when the first submit attempt is not confirmed", async () => {
    const dispatchKeyEvent = vi.fn().mockResolvedValue(undefined);
    const insertText = vi.fn().mockResolvedValue(undefined);
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ unitKey: "assistant-before", reply: "旧回复" })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: false, reason: "submit_not_confirmed" })
      .mockResolvedValueOnce({ submitted: false, reason: "submit_not_confirmed" })
      .mockResolvedValueOnce({ submitted: false, reason: "submit_not_confirmed" })
      .mockResolvedValueOnce({ submitted: false, reason: "submit_not_confirmed" })
      .mockResolvedValueOnce({ submitted: false, reason: "submit_not_confirmed" })
      .mockResolvedValueOnce({ submitted: true, reason: "entered_streaming_state" });

    const driver = new CodexDesktopDriver({
      connect: vi.fn().mockResolvedValue({
        appName: "Codex",
        browserVersion: "Codex/1.0",
        browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
      }),
      listTargets: vi.fn().mockResolvedValue([
        {
          id: "page-1",
          title: "Codex",
          type: "page",
          url: "app://codex"
        }
      ]),
      evaluateOnPage,
      dispatchKeyEvent,
      insertText
    } as unknown as CdpSession);

    await expect(
      driver.sendUserMessage(
        {
          sessionKey: "qqbot:default::qq:c2c:OPENID123",
          codexThreadRef: "cdp-target:page-1"
        },
        {
          messageId: "msg-retry-submit",
          accountKey: "qqbot:default",
          sessionKey: "qqbot:default::qq:c2c:OPENID123",
          peerKey: "qq:c2c:OPENID123",
          chatType: "c2c",
          senderId: "OPENID123",
          text: "请帮我测试发送重试",
          receivedAt: "2026-04-10T11:00:00.000Z"
        }
      )
    ).resolves.toBeUndefined();

    expect(dispatchKeyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ key: "Enter", type: "keyDown" }),
      "page-1"
    );
    expect(dispatchKeyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ key: "Enter", type: "keyUp" }),
      "page-1"
    );
  });

  it("does not send a fallback Enter when the first submit is confirmed a moment later", async () => {
    const dispatchKeyEvent = vi.fn().mockResolvedValue(undefined);
    const insertText = vi.fn().mockResolvedValue(undefined);
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ unitKey: "assistant-before", reply: "旧回复" })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: false, reason: "submit_not_confirmed" })
      .mockResolvedValueOnce({ submitted: false, reason: "submit_not_confirmed" })
      .mockResolvedValueOnce({ submitted: true, reason: "entered_streaming_state" });

    const driver = new CodexDesktopDriver({
      connect: vi.fn().mockResolvedValue({
        appName: "Codex",
        browserVersion: "Codex/1.0",
        browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
      }),
      listTargets: vi.fn().mockResolvedValue([
        {
          id: "page-1",
          title: "Codex",
          type: "page",
          url: "app://codex"
        }
      ]),
      evaluateOnPage,
      dispatchKeyEvent,
      insertText
    } as unknown as CdpSession, {
      sleep: async () => undefined
    });

    await expect(
      driver.sendUserMessage(
        {
          sessionKey: "qqbot:default::qq:c2c:OPENID123",
          codexThreadRef: "cdp-target:page-1"
        },
        {
          messageId: "msg-delayed-confirm",
          accountKey: "qqbot:default",
          sessionKey: "qqbot:default::qq:c2c:OPENID123",
          peerKey: "qq:c2c:OPENID123",
          chatType: "c2c",
          senderId: "OPENID123",
          text: "这条消息不该补发 Enter",
          receivedAt: "2026-04-10T11:01:00.000Z"
        }
      )
    ).resolves.toBeUndefined();

    expect(dispatchKeyEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: "Enter", type: "keyDown" }),
      "page-1"
    );
    expect(dispatchKeyEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: "Enter", type: "keyUp" }),
      "page-1"
    );
  });

  it("treats conversation advancement as a successful submit even when the composer text lingers", async () => {
    const dispatchKeyEvent = vi.fn().mockResolvedValue(undefined);
    const insertText = vi.fn().mockResolvedValue(undefined);
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ unitKey: "assistant-before", reply: "旧回复" })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: false, reason: "submit_not_confirmed" })
      .mockResolvedValueOnce({ submitted: false, reason: "submit_not_confirmed" })
      .mockResolvedValueOnce({ submitted: true, reason: "conversation_advanced" });

    const driver = new CodexDesktopDriver({
      connect: vi.fn().mockResolvedValue({
        appName: "Codex",
        browserVersion: "Codex/1.0",
        browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
      }),
      listTargets: vi.fn().mockResolvedValue([
        {
          id: "page-1",
          title: "Codex",
          type: "page",
          url: "app://codex"
        }
      ]),
      evaluateOnPage,
      dispatchKeyEvent,
      insertText
    } as unknown as CdpSession, {
      sleep: async () => undefined
    });

    await expect(
      driver.sendUserMessage(
        {
          sessionKey: "qqbot:default::qq:c2c:OPENID123",
          codexThreadRef: "cdp-target:page-1"
        },
        {
          messageId: "msg-conversation-advanced",
          accountKey: "qqbot:default",
          sessionKey: "qqbot:default::qq:c2c:OPENID123",
          peerKey: "qq:c2c:OPENID123",
          chatType: "c2c",
          senderId: "OPENID123",
          text: "这条消息靠对话前进确认发送成功",
          receivedAt: "2026-04-18T10:00:00.000Z"
        }
      )
    ).resolves.toBeUndefined();

    expect(dispatchKeyEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: "Enter", type: "keyDown" }),
      "page-1"
    );
  });

  it("throws a submit_failed driver error when the composer text remains unsent", async () => {
    const dispatchKeyEvent = vi.fn().mockResolvedValue(undefined);
    const insertText = vi.fn().mockResolvedValue(undefined);
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ unitKey: "assistant-before", reply: "旧回复" })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: false, reason: "submit_not_confirmed" })
      .mockResolvedValueOnce({ submitted: false, reason: "submit_not_confirmed" })
      .mockResolvedValueOnce({ submitted: false, reason: "submit_not_confirmed" })
      .mockResolvedValueOnce({ submitted: false, reason: "submit_not_confirmed" })
      .mockResolvedValueOnce({ submitted: false, reason: "submit_not_confirmed" })
      .mockResolvedValueOnce({ submitted: false, reason: "submit_not_confirmed" })
      .mockResolvedValueOnce({ submitted: false, reason: "submit_not_confirmed" })
      .mockResolvedValueOnce({ submitted: false, reason: "submit_not_confirmed" })
      .mockResolvedValueOnce({ submitted: false, reason: "submit_not_confirmed" });

    const driver = new CodexDesktopDriver({
      connect: vi.fn().mockResolvedValue({
        appName: "Codex",
        browserVersion: "Codex/1.0",
        browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
      }),
      listTargets: vi.fn().mockResolvedValue([
        {
          id: "page-1",
          title: "Codex",
          type: "page",
          url: "app://codex"
        }
      ]),
      evaluateOnPage,
      dispatchKeyEvent,
      insertText
    } as unknown as CdpSession);

    await expect(
      driver.sendUserMessage(
        {
          sessionKey: "qqbot:default::qq:c2c:OPENID123",
          codexThreadRef: "cdp-target:page-1"
        },
        {
          messageId: "msg-submit-failed",
          accountKey: "qqbot:default",
          sessionKey: "qqbot:default::qq:c2c:OPENID123",
          peerKey: "qq:c2c:OPENID123",
          chatType: "c2c",
          senderId: "OPENID123",
          text: "这条消息应该触发 submit_failed",
          receivedAt: "2026-04-10T11:02:00.000Z"
        }
      )
    ).rejects.toEqual(
      new DesktopDriverError(
        "Codex desktop composer submit failed: submit_not_confirmed",
        "submit_failed"
      )
    );
  });

  it("collects the latest assistant reply from page text via cdp evaluation", async () => {
    const evaluateOnPage = vi.fn().mockResolvedValue("User: hi\nAssistant: first\nAssistant: latest");
    const driver = new CodexDesktopDriver({
      connect: vi.fn().mockResolvedValue({
        appName: "Codex",
        browserVersion: "Codex/1.0",
        browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
      }),
      listTargets: vi.fn().mockResolvedValue([
        {
          id: "page-1",
          title: "Codex",
          type: "page",
          url: "app://codex"
        }
      ]),
      evaluateOnPage
    } as unknown as CdpSession);

    await expect(
      driver.collectAssistantReply({
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        codexThreadRef: "cdp-target:page-1"
      })
    ).resolves.toMatchObject([
      {
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        text: "latest"
      }
    ]);
    expect(evaluateOnPage).toHaveBeenCalledWith("document.body.innerText", "page-1");
  });

  it("prefers assistant reply units rendered by the current Codex desktop ui", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ reply: "current desktop reply" })
      .mockResolvedValueOnce({ reply: "current desktop reply" })
      .mockResolvedValueOnce({ reply: "current desktop reply" });
    const driver = new CodexDesktopDriver({
      connect: vi.fn().mockResolvedValue({
        appName: "Codex",
        browserVersion: "Codex/1.0",
        browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
      }),
      listTargets: vi.fn().mockResolvedValue([
        {
          id: "page-1",
          title: "Codex",
          type: "page",
          url: "app://codex"
        }
      ]),
      evaluateOnPage
    } as unknown as CdpSession);

    await expect(
      driver.collectAssistantReply({
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        codexThreadRef: "cdp-target:page-1"
      })
    ).resolves.toMatchObject([
      {
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        text: "current desktop reply"
      }
    ]);
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("data-content-search-unit-key"),
      "page-1"
    );
    expect(evaluateOnPage).not.toHaveBeenCalledWith("document.body.innerText", "page-1");
  });

  it("polls until a new assistant reply appears after sending the user message", async () => {
    const dispatchKeyEvent = vi.fn().mockResolvedValue(undefined);
    const insertText = vi.fn().mockResolvedValue(undefined);
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ reply: "old reply" })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" })
      .mockResolvedValueOnce({ reply: "old reply" })
      .mockResolvedValueOnce({ reply: "fresh reply" })
      .mockResolvedValueOnce({ reply: "fresh reply" })
      .mockResolvedValueOnce({ reply: "fresh reply" });
    const driver = new CodexDesktopDriver(
      {
        connect: vi.fn().mockResolvedValue({
          appName: "Codex",
          browserVersion: "Codex/1.0",
          browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
        }),
        listTargets: vi.fn().mockResolvedValue([
          {
            id: "page-1",
            title: "Codex",
            type: "page",
            url: "app://codex"
          }
        ]),
        evaluateOnPage,
        dispatchKeyEvent,
        insertText
      } as unknown as CdpSession,
      {
        replyPollIntervalMs: 0,
        sleep: async () => undefined
      }
    );

    const binding = {
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "cdp-target:page-1"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      senderId: "OPENID123",
      text: "new message",
      receivedAt: "2026-04-09T12:00:00.000Z"
    });

    await expect(driver.collectAssistantReply(binding)).resolves.toMatchObject([
      {
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        text: "fresh reply"
      }
    ]);
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("data-content-search-unit-key"),
      "page-1"
    );
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("[data-codex-composer"),
      "page-1"
    );
    expect(dispatchKeyEvent).toHaveBeenNthCalledWith(
      1,
      {
        type: "keyDown",
        commands: ["selectAll"]
      },
      "page-1"
    );
    expect(dispatchKeyEvent).toHaveBeenNthCalledWith(
      2,
      {
        type: "keyDown",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8
      },
      "page-1"
    );
    expect(dispatchKeyEvent).toHaveBeenNthCalledWith(
      3,
      {
        type: "keyUp",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8
      },
      "page-1"
    );
    expect(insertText).toHaveBeenCalledWith("new message", "page-1");
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("clicked_send_button"),
      "page-1"
    );
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("data-content-search-unit-key"),
      "page-1"
    );
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("data-content-search-unit-key"),
      "page-1"
    );
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      6,
      expect.stringContaining("data-content-search-unit-key"),
      "page-1"
    );
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      7,
      expect.stringContaining("data-content-search-unit-key"),
      "page-1"
    );
  });

  it("waits for the streamed assistant reply to stabilize before returning it", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ reply: "old reply" })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" })
      .mockResolvedValueOnce({ reply: "old reply" })
      .mockResolvedValueOnce({ reply: "新" })
      .mockResolvedValueOnce({ reply: "新的" })
      .mockResolvedValueOnce({ reply: "新的完整回复" })
      .mockResolvedValueOnce({ reply: "新的完整回复" })
      .mockResolvedValueOnce({ reply: "新的完整回复" });

    const driver = new CodexDesktopDriver(
      {
        connect: vi.fn().mockResolvedValue({
          appName: "Codex",
          browserVersion: "Codex/1.0",
          browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
        }),
        listTargets: vi.fn().mockResolvedValue([
          {
            id: "page-1",
            title: "Codex",
            type: "page",
            url: "app://codex"
          }
        ]),
        evaluateOnPage,
        dispatchKeyEvent: vi.fn().mockResolvedValue(undefined),
        insertText: vi.fn().mockResolvedValue(undefined)
      } as unknown as CdpSession,
      {
        replyPollIntervalMs: 0,
        sleep: async () => undefined
      }
    );

    const binding = {
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "cdp-target:page-1"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-stream",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      senderId: "OPENID123",
      text: "请流式输出",
      receivedAt: "2026-04-09T12:30:00.000Z"
    });

    await expect(driver.collectAssistantReply(binding)).resolves.toMatchObject([
      {
        text: "新的完整回复"
      }
    ]);
  });

  it("treats a new assistant unit as a fresh reply even when the text matches the baseline", async () => {
    const dispatchKeyEvent = vi.fn().mockResolvedValue(undefined);
    const insertText = vi.fn().mockResolvedValue(undefined);
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ unitKey: "assistant-1", reply: "相同内容" })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" })
      .mockResolvedValueOnce({ unitKey: "assistant-2", reply: "相同内容" })
      .mockResolvedValueOnce({ unitKey: "assistant-2", reply: "相同内容" })
      .mockResolvedValueOnce({ unitKey: "assistant-2", reply: "相同内容" });

    const driver = new CodexDesktopDriver(
      {
        connect: vi.fn().mockResolvedValue({
          appName: "Codex",
          browserVersion: "Codex/1.0",
          browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
        }),
        listTargets: vi.fn().mockResolvedValue([
          {
            id: "page-1",
            title: "Codex",
            type: "page",
            url: "app://codex"
          }
        ]),
        evaluateOnPage,
        dispatchKeyEvent,
        insertText
      } as unknown as CdpSession,
      {
        replyPollIntervalMs: 0,
        sleep: async () => undefined
      }
    );

    const binding = {
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "cdp-target:page-1"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-same-text-new-unit",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      senderId: "OPENID123",
      text: "请再回答一次同样的话",
      receivedAt: "2026-04-09T17:35:00.000Z"
    });

    await expect(driver.collectAssistantReply(binding)).resolves.toMatchObject([
      {
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        text: "相同内容"
      }
    ]);
  });

  it("captures media references rendered in the current codex assistant unit", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({
        unitKey: "assistant-media-1",
        reply: "这是你要的素材",
        mediaReferences: [
          "/tmp/qq-media/test-image.png",
          "https://example.com/test-audio.mp3"
        ]
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-media-1",
        reply: "这是你要的素材",
        mediaReferences: [
          "/tmp/qq-media/test-image.png",
          "https://example.com/test-audio.mp3"
        ]
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-media-1",
        reply: "这是你要的素材",
        mediaReferences: [
          "/tmp/qq-media/test-image.png",
          "https://example.com/test-audio.mp3"
        ]
      });
    const driver = new CodexDesktopDriver({
      connect: vi.fn().mockResolvedValue({
        appName: "Codex",
        browserVersion: "Codex/1.0",
        browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
      }),
      listTargets: vi.fn().mockResolvedValue([
        {
          id: "page-1",
          title: "Codex",
          type: "page",
          url: "app://codex"
        }
      ]),
      evaluateOnPage
    } as unknown as CdpSession);

    await expect(
      driver.collectAssistantReply({
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        codexThreadRef: "cdp-target:page-1"
      })
    ).resolves.toMatchObject([
      {
        text: "这是你要的素材",
        mediaArtifacts: [
          expect.objectContaining({
            localPath: "/tmp/qq-media/test-image.png"
          }),
          expect.objectContaining({
            sourceUrl: "https://example.com/test-audio.mp3"
          })
        ]
      }
    ]);
  });

  it("returns a media-only assistant reply even when the reply text is empty", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({
        unitKey: "assistant-media-only-1",
        reply: null,
        mediaReferences: [
          "/tmp/qq-media/only-image-a.png",
          "/tmp/qq-media/only-image-b.png"
        ],
        isStreaming: false
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-media-only-1",
        reply: null,
        mediaReferences: [
          "/tmp/qq-media/only-image-a.png",
          "/tmp/qq-media/only-image-b.png"
        ],
        isStreaming: false
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-media-only-1",
        reply: null,
        mediaReferences: [
          "/tmp/qq-media/only-image-a.png",
          "/tmp/qq-media/only-image-b.png"
        ],
        isStreaming: false
      });

    const driver = new CodexDesktopDriver({
      connect: vi.fn().mockResolvedValue({
        appName: "Codex",
        browserVersion: "Codex/1.0",
        browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
      }),
      listTargets: vi.fn().mockResolvedValue([
        {
          id: "page-1",
          title: "Codex",
          type: "page",
          url: "app://codex"
        }
      ]),
      evaluateOnPage
    } as unknown as CdpSession);

    await expect(
      driver.collectAssistantReply({
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        codexThreadRef: "cdp-target:page-1"
      })
    ).resolves.toMatchObject([
      {
        text: "",
        mediaArtifacts: [
          expect.objectContaining({
            localPath: "/tmp/qq-media/only-image-a.png"
          }),
          expect.objectContaining({
            localPath: "/tmp/qq-media/only-image-b.png"
          })
        ]
      }
    ]);
  });

  it("keeps ordinary reference links in reply text instead of treating them as qq media uploads", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({
        unitKey: "assistant-links-1",
        reply: "参考：\n泸沽湖观景台行程资料\nhttps://example.com/yunnan.pdf\n澎湃：格姆女神山可俯瞰泸沽湖全貌\nhttps://m.thepaper.cn/baijiahao_22780218",
        mediaReferences: []
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-links-1",
        reply: "参考：\n泸沽湖观景台行程资料\nhttps://example.com/yunnan.pdf\n澎湃：格姆女神山可俯瞰泸沽湖全貌\nhttps://m.thepaper.cn/baijiahao_22780218",
        mediaReferences: []
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-links-1",
        reply: "参考：\n泸沽湖观景台行程资料\nhttps://example.com/yunnan.pdf\n澎湃：格姆女神山可俯瞰泸沽湖全貌\nhttps://m.thepaper.cn/baijiahao_22780218",
        mediaReferences: []
      });

    const driver = new CodexDesktopDriver({
      connect: vi.fn().mockResolvedValue({
        appName: "Codex",
        browserVersion: "Codex/1.0",
        browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
      }),
      listTargets: vi.fn().mockResolvedValue([
        {
          id: "page-1",
          title: "Codex",
          type: "page",
          url: "app://codex"
        }
      ]),
      evaluateOnPage
    } as unknown as CdpSession);

    await expect(
      driver.collectAssistantReply({
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        codexThreadRef: "cdp-target:page-1"
      })
    ).resolves.toMatchObject([
      {
        text: "参考：\n泸沽湖观景台行程资料\nhttps://example.com/yunnan.pdf\n澎湃：格姆女神山可俯瞰泸沽湖全貌\nhttps://m.thepaper.cn/baijiahao_22780218"
      }
    ]);
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("link.textContent = replacement"),
      "page-1"
    );
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("normalizedHref && isLocalReference(normalizedHref)"),
      "page-1"
    );
  });

  it("preserves ordered list numbering when serializing rich codex replies", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({
        unitKey: "assistant-list-1",
        reply: "1. 白天阳光海滩\n2. 日落金色沙滩\n3. 热带海岛风",
        mediaReferences: []
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-list-1",
        reply: "1. 白天阳光海滩\n2. 日落金色沙滩\n3. 热带海岛风",
        mediaReferences: []
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-list-1",
        reply: "1. 白天阳光海滩\n2. 日落金色沙滩\n3. 热带海岛风",
        mediaReferences: []
      });

    const driver = new CodexDesktopDriver({
      connect: vi.fn().mockResolvedValue({
        appName: "Codex",
        browserVersion: "Codex/1.0",
        browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
      }),
      listTargets: vi.fn().mockResolvedValue([
        {
          id: "page-1",
          title: "Codex",
          type: "page",
          url: "app://codex"
        }
      ]),
      evaluateOnPage
    } as unknown as CdpSession);

    await expect(
      driver.collectAssistantReply({
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        codexThreadRef: "cdp-target:page-1"
      })
    ).resolves.toMatchObject([
      {
        text: "1. 白天阳光海滩\n2. 日落金色沙滩\n3. 热带海岛风"
      }
    ]);
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("if (tagName === 'OL')"),
      "page-1"
    );
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("return String(index + 1) + '. ' + content;"),
      "page-1"
    );
  });

  it("serializes codex code blocks as fenced markdown before qq delivery", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({
        unitKey: "assistant-code-1",
        reply: [
          "下面给你一段 JavaScript 闭包示例代码：",
          "```javascript",
          "function createCounter() {",
          "  let count = 0;",
          "  return function () {",
          "    count++;",
          "    return count;",
          "  };",
          "}",
          "```"
        ].join("\n"),
        mediaReferences: []
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-code-1",
        reply: [
          "下面给你一段 JavaScript 闭包示例代码：",
          "```javascript",
          "function createCounter() {",
          "  let count = 0;",
          "  return function () {",
          "    count++;",
          "    return count;",
          "  };",
          "}",
          "```"
        ].join("\n"),
        mediaReferences: []
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-code-1",
        reply: [
          "下面给你一段 JavaScript 闭包示例代码：",
          "```javascript",
          "function createCounter() {",
          "  let count = 0;",
          "  return function () {",
          "    count++;",
          "    return count;",
          "  };",
          "}",
          "```"
        ].join("\n"),
        mediaReferences: []
      });

    const driver = new CodexDesktopDriver({
      connect: vi.fn().mockResolvedValue({
        appName: "Codex",
        browserVersion: "Codex/1.0",
        browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
      }),
      listTargets: vi.fn().mockResolvedValue([
        {
          id: "page-1",
          title: "Codex",
          type: "page",
          url: "app://codex"
        }
      ]),
      evaluateOnPage
    } as unknown as CdpSession);

    await expect(
      driver.collectAssistantReply({
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        codexThreadRef: "cdp-target:page-1"
      })
    ).resolves.toMatchObject([
      {
        text: [
          "下面给你一段 JavaScript 闭包示例代码：",
          "```javascript",
          "function createCounter() {",
          "  let count = 0;",
          "  return function () {",
          "    count++;",
          "    return count;",
          "  };",
          "}",
          "```"
        ].join("\n")
      }
    ]);
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("if (tagName === 'PRE')"),
      "page-1"
    );
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("bg-token-text-code-block-background"),
      "page-1"
    );
  });

  it("waits for codex to finish generating even if the first sentence is already stable", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ reply: "old reply", isStreaming: false })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" })
      .mockResolvedValueOnce({ unitKey: "assistant-3", reply: "先给一句", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-3", reply: "先给一句", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-3", reply: "先给一句", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-3", reply: "先给一句\n完整结果", isStreaming: false })
      .mockResolvedValueOnce({ unitKey: "assistant-3", reply: "先给一句\n完整结果", isStreaming: false })
      .mockResolvedValueOnce({ unitKey: "assistant-3", reply: "先给一句\n完整结果", isStreaming: false });

    const driver = new CodexDesktopDriver(
      {
        connect: vi.fn().mockResolvedValue({
          appName: "Codex",
          browserVersion: "Codex/1.0",
          browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
        }),
        listTargets: vi.fn().mockResolvedValue([
          {
            id: "page-1",
            title: "Codex",
            type: "page",
            url: "app://codex"
          }
        ]),
        evaluateOnPage,
        dispatchKeyEvent: vi.fn().mockResolvedValue(undefined),
        insertText: vi.fn().mockResolvedValue(undefined)
      } as unknown as CdpSession,
      {
        replyPollIntervalMs: 0,
        sleep: async () => undefined
      }
    );

    const binding = {
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "cdp-target:page-1"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-thinking-after-first-sentence",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      senderId: "OPENID123",
      text: "请先回答一句，再继续思考并补完整结果",
      receivedAt: "2026-04-09T19:40:00.000Z"
    });

    await expect(driver.collectAssistantReply(binding)).resolves.toMatchObject([
      {
        text: "先给一句\n完整结果"
      }
    ]);
  });

  it("falls back to the last observed assistant reply when completion polling times out", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ reply: "old reply", isStreaming: false })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" })
      .mockResolvedValueOnce({ unitKey: "assistant-timeout-1", reply: "这是已经生成出来的结果", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-timeout-1", reply: "这是已经生成出来的结果", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-timeout-1", reply: "这是已经生成出来的结果", isStreaming: true });

    const driver = new CodexDesktopDriver(
      {
        connect: vi.fn().mockResolvedValue({
          appName: "Codex",
          browserVersion: "Codex/1.0",
          browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
        }),
        listTargets: vi.fn().mockResolvedValue([
          {
            id: "page-1",
            title: "Codex",
            type: "page",
            url: "app://codex"
          }
        ]),
        evaluateOnPage,
        dispatchKeyEvent: vi.fn().mockResolvedValue(undefined),
        insertText: vi.fn().mockResolvedValue(undefined)
      } as unknown as CdpSession,
      {
        replyPollAttempts: 3,
        maxReplyPollAttempts: 3,
        replyPollIntervalMs: 0,
        replyStablePolls: 3,
        sleep: vi.fn().mockResolvedValue(undefined)
      }
    );

    const binding = {
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "cdp-target:page-1"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-timeout-fallback",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      senderId: "OPENID123",
      text: "请回答",
      receivedAt: "2026-04-09T21:40:00.000Z"
    });

    await expect(driver.collectAssistantReply(binding)).resolves.toMatchObject([
      {
        text: "这是已经生成出来的结果"
      }
    ]);
  });

  it("emits incremental drafts while the assistant reply grows across multiple phases", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ reply: "old reply", isStreaming: false })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" })
      .mockResolvedValueOnce({ unitKey: "assistant-stream-1", reply: "先回一句", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-stream-1", reply: "先回一句", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-stream-1", reply: "先回一句", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-stream-1", reply: "先回一句\n继续补充", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-stream-1", reply: "先回一句\n继续补充", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-stream-1", reply: "先回一句\n继续补充", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-stream-1", reply: "先回一句\n继续补充\n最终结论", isStreaming: false })
      .mockResolvedValueOnce({ unitKey: "assistant-stream-1", reply: "先回一句\n继续补充\n最终结论", isStreaming: false });

    const driver = new CodexDesktopDriver(
      {
        connect: vi.fn().mockResolvedValue({
          appName: "Codex",
          browserVersion: "Codex/1.0",
          browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
        }),
        listTargets: vi.fn().mockResolvedValue([
          {
            id: "page-1",
            title: "Codex",
            type: "page",
            url: "app://codex"
          }
        ]),
        evaluateOnPage,
        dispatchKeyEvent: vi.fn().mockResolvedValue(undefined),
        insertText: vi.fn().mockResolvedValue(undefined)
      } as unknown as CdpSession,
      {
        replyPollAttempts: 12,
        replyPollIntervalMs: 0,
        replyStablePolls: 2,
        sleep: async () => undefined
      }
    );

    const binding = {
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "cdp-target:page-1"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-incremental-stream",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      senderId: "OPENID123",
      text: "请分阶段回答",
      receivedAt: "2026-04-10T11:00:00.000Z"
    });

    const emitted: OutboundDraft[] = [];
    const finalDrafts = await driver.collectAssistantReply(binding, {
      onDraft: async (draft) => {
        emitted.push(draft);
      }
    });

    expect(emitted).toMatchObject([
      { text: "先回一句" },
      { text: "继续补充" },
      { text: "最终结论" }
    ]);
    expect(finalDrafts).toEqual([]);
  });

  it("emits turn events while collecting assistant reply", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ reply: "old reply", isStreaming: false })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" })
      .mockResolvedValueOnce({ unitKey: "assistant-turn-event-1", reply: "先回一句", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-turn-event-1", reply: "先回一句", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-turn-event-1", reply: "先回一句", isStreaming: true })
      .mockResolvedValueOnce({
        unitKey: "assistant-turn-event-1",
        reply: "先回一句\n最终结论",
        isStreaming: false
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-turn-event-1",
        reply: "先回一句\n最终结论",
        isStreaming: false
      });

    const driver = new CodexDesktopDriver(
      {
        connect: vi.fn().mockResolvedValue({
          appName: "Codex",
          browserVersion: "Codex/1.0",
          browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
        }),
        listTargets: vi.fn().mockResolvedValue([
          {
            id: "page-1",
            title: "Codex",
            type: "page",
            url: "app://codex"
          }
        ]),
        evaluateOnPage,
        dispatchKeyEvent: vi.fn().mockResolvedValue(undefined),
        insertText: vi.fn().mockResolvedValue(undefined)
      } as unknown as CdpSession,
      {
        replyPollAttempts: 10,
        replyPollIntervalMs: 0,
        replyStablePolls: 2,
        partialReplyStablePolls: 2,
        sleep: async () => undefined
      }
    );

    const binding = {
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "cdp-target:page-1"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-turn-event-stream",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      senderId: "OPENID123",
      text: "请分阶段回答并结束",
      receivedAt: "2026-04-12T00:10:00.000Z"
    });

    const events: TurnEvent[] = [];
    const finalDrafts = await driver.collectAssistantReply(binding, {
      onTurnEvent: async (event) => {
        events.push(event);
      }
    });

    expect(finalDrafts).toMatchObject([
      {
        text: "先回一句\n最终结论"
      }
    ]);
    expect(events.some((event) => event.eventType === TurnEventType.Delta)).toBe(true);
    expect(events.at(-1)?.eventType).toBe(TurnEventType.Completed);
    expect(events.at(-1)?.payload.fullText).toContain("最终结论");
  });

  it("emits newly discovered media references through onDraft even when no new text arrives", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ reply: "old reply", isStreaming: false })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" })
      .mockResolvedValueOnce({
        unitKey: "assistant-media-delta-1",
        reply: "我先去外接硬盘里定位目录。",
        mediaReferences: [],
        isStreaming: true
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-media-delta-1",
        reply: "我先去外接硬盘里定位目录。",
        mediaReferences: [],
        isStreaming: true
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-media-delta-1",
        reply: "我先去外接硬盘里定位目录。",
        mediaReferences: [],
        isStreaming: true
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-media-delta-1",
        reply: "我先去外接硬盘里定位目录。",
        mediaReferences: [
          "/tmp/qq-media/final-a.png",
          "/tmp/qq-media/final-b.png"
        ],
        isStreaming: false
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-media-delta-1",
        reply: "我先去外接硬盘里定位目录。",
        mediaReferences: [
          "/tmp/qq-media/final-a.png",
          "/tmp/qq-media/final-b.png"
        ],
        isStreaming: false
      });

    const driver = new CodexDesktopDriver(
      {
        connect: vi.fn().mockResolvedValue({
          appName: "Codex",
          browserVersion: "Codex/1.0",
          browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
        }),
        listTargets: vi.fn().mockResolvedValue([
          {
            id: "page-1",
            title: "Codex",
            type: "page",
            url: "app://codex"
          }
        ]),
        evaluateOnPage,
        dispatchKeyEvent: vi.fn().mockResolvedValue(undefined),
        insertText: vi.fn().mockResolvedValue(undefined)
      } as unknown as CdpSession,
      {
        replyPollAttempts: 10,
        replyPollIntervalMs: 0,
        replyStablePolls: 2,
        sleep: async () => undefined
      }
    );

    const binding = {
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "cdp-target:page-1"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-media-delta-stream",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      senderId: "OPENID123",
      text: "帮我把最终图片也发出来",
      receivedAt: "2026-04-10T11:05:00.000Z"
    });

    const emitted: OutboundDraft[] = [];
    const finalDrafts = await driver.collectAssistantReply(binding, {
      onDraft: async (draft) => {
        emitted.push(draft);
      }
    });

    expect(emitted).toMatchObject([
      { text: "我先去外接硬盘里定位目录。" },
      {
        text: "",
        mediaArtifacts: [
          expect.objectContaining({
            localPath: "/tmp/qq-media/final-a.png"
          }),
          expect.objectContaining({
            localPath: "/tmp/qq-media/final-b.png"
          })
        ]
      }
    ]);
    expect(finalDrafts).toEqual([]);
  });

  it("prefers the local rollout reader when a fresh local cursor is available", async () => {
    const encodedThreadRef = `codex-thread:page-1:${Buffer.from(
      JSON.stringify({
        title: "线程 A",
        projectName: null
      }),
      "utf8"
    ).toString("base64url")}`;
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce([
        {
          title: "线程 A",
          projectName: null,
          relativeTime: "刚刚",
          isCurrent: true
        }
      ])
      .mockResolvedValueOnce({ reply: "old reply", isStreaming: false })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" });

    const localRolloutReader = {
      captureCursorForThreadTitle: vi.fn().mockReturnValue({
        threadId: "thread-a",
        rolloutPath: "/tmp/rollout-thread-a.jsonl",
        lineCount: 3
      }),
      waitForTurnCompletion: vi.fn().mockResolvedValue({
        turnId: "turn-local-123",
        commentaryMessages: ["我先同步一下本地会话。"],
        finalText: "最终结论\n<qqmedia>/tmp/final-image.png</qqmedia>",
        fullText:
          "我先同步一下本地会话。\n最终结论\n<qqmedia>/tmp/final-image.png</qqmedia>",
        mediaReferences: ["/tmp/final-image.png"]
      })
    };

    const driver = new CodexDesktopDriver(
      {
        connect: vi.fn().mockResolvedValue({
          appName: "Codex",
          browserVersion: "Codex/1.0",
          browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
        }),
        listTargets: vi.fn().mockResolvedValue([
          {
            id: "page-1",
            title: "Codex",
            type: "page",
            url: "app://codex"
          }
        ]),
        evaluateOnPage,
        dispatchKeyEvent: vi.fn().mockResolvedValue(undefined),
        insertText: vi.fn().mockResolvedValue(undefined)
      } as unknown as CdpSession,
      {
        replyPollIntervalMs: 0,
        sleep: async () => undefined,
        localRolloutReader
      }
    );

    const binding = {
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: encodedThreadRef
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-local-rollout",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      senderId: "OPENID123",
      text: "请优先从本地会话里读回复",
      receivedAt: "2026-04-19T10:15:00.000Z"
    });

    const emitted: OutboundDraft[] = [];
    const events: TurnEvent[] = [];
    const finalDrafts = await driver.collectAssistantReply(binding, {
      onDraft: async (draft) => {
        emitted.push(draft);
      },
      onTurnEvent: async (event) => {
        events.push(event);
      }
    });

    expect(localRolloutReader.captureCursorForThreadTitle).toHaveBeenCalledWith("线程 A");
    expect(localRolloutReader.waitForTurnCompletion).toHaveBeenCalled();
    expect(emitted).toMatchObject([
      {
        text: "我先同步一下本地会话。",
        turnId: "turn-local-123"
      }
    ]);
    expect(finalDrafts).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      turnId: "turn-local-123",
      eventType: TurnEventType.Completed,
      payload: {
        fullText:
          "我先同步一下本地会话。\n最终结论\n<qqmedia>/tmp/final-image.png</qqmedia>",
        mediaReferences: ["/tmp/final-image.png"]
      }
    });
    expect(evaluateOnPage).toHaveBeenCalledTimes(4);
  });

  it("captures the local rollout cursor before submitting the composer so the target turn can be locked from task_started", async () => {
    const encodedThreadRef = `codex-thread:page-1:${Buffer.from(
      JSON.stringify({
        title: "线程 A",
        projectName: null
      }),
      "utf8"
    ).toString("base64url")}`;
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce([
        {
          title: "线程 A",
          projectName: null,
          relativeTime: "刚刚",
          isCurrent: true
        }
      ])
      .mockResolvedValueOnce({ reply: "old reply", isStreaming: false })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" });

    const localRolloutReader = {
      captureCursorForThreadTitle: vi.fn().mockReturnValue({
        threadId: "thread-a",
        rolloutPath: "/tmp/rollout-thread-a.jsonl",
        lineCount: 3,
        targetTurnId: null,
        competingTurnStarted: false
      }),
      waitForTurnCompletion: vi.fn()
    };

    const driver = new CodexDesktopDriver(
      {
        connect: vi.fn().mockResolvedValue({
          appName: "Codex",
          browserVersion: "Codex/1.0",
          browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
        }),
        listTargets: vi.fn().mockResolvedValue([
          {
            id: "page-1",
            title: "Codex",
            type: "page",
            url: "app://codex"
          }
        ]),
        evaluateOnPage,
        dispatchKeyEvent: vi.fn().mockResolvedValue(undefined),
        insertText: vi.fn().mockResolvedValue(undefined)
      } as unknown as CdpSession,
      {
        replyPollIntervalMs: 0,
        sleep: async () => undefined,
        localRolloutReader
      }
    );

    await driver.sendUserMessage(
      {
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        codexThreadRef: encodedThreadRef
      },
      {
        messageId: "msg-local-rollout-order",
        accountKey: "qqbot:default",
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        peerKey: "qq:c2c:OPENID123",
        chatType: "c2c",
        senderId: "OPENID123",
        text: "发送前就要锁住本地 cursor",
        receivedAt: "2026-04-19T10:20:00.000Z"
      }
    );

    const captureOrder = localRolloutReader.captureCursorForThreadTitle.mock.invocationCallOrder[0];
    const submitOrder = evaluateOnPage.mock.invocationCallOrder[3];

    expect(captureOrder).toBeLessThan(submitOrder);
  });

  it("prefers the local transport logs to confirm submission and forwards the locked turn id into rollout reading", async () => {
    const encodedThreadRef = `codex-thread:page-1:${Buffer.from(
      JSON.stringify({
        title: "线程 A",
        projectName: null
      }),
      "utf8"
    ).toString("base64url")}`;
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce([
        {
          title: "线程 A",
          projectName: null,
          relativeTime: "刚刚",
          isCurrent: true
        }
      ])
      .mockResolvedValueOnce({ reply: "old reply", isStreaming: false })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" });
    const dispatchKeyEvent = vi.fn().mockResolvedValue(undefined);

    const localRolloutReader = {
      captureCursorForThreadTitle: vi.fn().mockReturnValue({
        threadId: "thread-a",
        rolloutPath: "/tmp/rollout-thread-a.jsonl",
        lineCount: 3,
        targetTurnId: null,
        competingTurnStarted: false
      }),
      waitForTurnCompletion: vi.fn().mockResolvedValue({
        turnId: "turn-log-123",
        commentaryMessages: [],
        finalText: "最终回复",
        fullText: "最终回复",
        mediaReferences: []
      })
    };
    const localSubmissionReader = {
      captureCursorForThreadId: vi.fn().mockReturnValue({
        threadId: "thread-a",
        lastLogId: 12
      }),
      waitForTurnSubmission: vi.fn().mockResolvedValue({
        submitted: true,
        turnId: "turn-log-123",
        reason: "submission_dispatch_logged"
      })
    };

    const driver = new CodexDesktopDriver(
      {
        connect: vi.fn().mockResolvedValue({
          appName: "Codex",
          browserVersion: "Codex/1.0",
          browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
        }),
        listTargets: vi.fn().mockResolvedValue([
          {
            id: "page-1",
            title: "Codex",
            type: "page",
            url: "app://codex"
          }
        ]),
        evaluateOnPage,
        dispatchKeyEvent,
        insertText: vi.fn().mockResolvedValue(undefined)
      } as unknown as CdpSession,
      {
        replyPollIntervalMs: 0,
        sleep: async () => undefined,
        localRolloutReader,
        localSubmissionReader
      }
    );

    const binding = {
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: encodedThreadRef
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-local-submission",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      senderId: "OPENID123",
      text: "先通过本地 transport log 确认提交",
      receivedAt: "2026-04-19T12:00:00.000Z"
    });

    await driver.collectAssistantReply(binding);

    expect(localSubmissionReader.captureCursorForThreadId).toHaveBeenCalledWith("thread-a");
    expect(localSubmissionReader.waitForTurnSubmission).toHaveBeenCalled();
    expect(localRolloutReader.waitForTurnCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-a",
        targetTurnId: "turn-log-123"
      }),
      expect.any(Object)
    );
    expect(dispatchKeyEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: "Enter", type: "keyDown" }),
      "page-1"
    );
    expect(evaluateOnPage).toHaveBeenCalledTimes(4);
  });

  it("probes the composer button icon as a streaming fallback signal", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ reply: "old reply", isStreaming: false })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" })
      .mockResolvedValueOnce({ unitKey: "assistant-4", reply: "先给一句", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-4", reply: "先给一句\n完整结果", isStreaming: false })
      .mockResolvedValueOnce({ unitKey: "assistant-4", reply: "先给一句\n完整结果", isStreaming: false })
      .mockResolvedValueOnce({ unitKey: "assistant-4", reply: "先给一句\n完整结果", isStreaming: false });

    const driver = new CodexDesktopDriver(
      {
        connect: vi.fn().mockResolvedValue({
          appName: "Codex",
          browserVersion: "Codex/1.0",
          browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
        }),
        listTargets: vi.fn().mockResolvedValue([
          {
            id: "page-1",
            title: "Codex",
            type: "page",
            url: "app://codex"
          }
        ]),
        evaluateOnPage,
        dispatchKeyEvent: vi.fn().mockResolvedValue(undefined),
        insertText: vi.fn().mockResolvedValue(undefined)
      } as unknown as CdpSession,
      {
        replyPollIntervalMs: 0,
        sleep: async () => undefined
      }
    );

    const binding = {
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "cdp-target:page-1"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-stop-icon-streaming",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      senderId: "OPENID123",
      text: "先回答一句，再继续思考",
      receivedAt: "2026-04-09T20:10:00.000Z"
    });

    await expect(driver.collectAssistantReply(binding)).resolves.toMatchObject([
      {
        text: "先给一句\n完整结果"
      }
    ]);
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("size-token-button-composer"),
      "page-1"
    );
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("M4.5 5.75C4.5 5.05964"),
      "page-1"
    );
  });

  it("keeps polling when the latest assistant unit still shows reconnecting activity", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ reply: "old reply", isStreaming: false })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" })
      .mockResolvedValueOnce({ unitKey: "assistant-reconnect-1", reply: "我先去外接硬盘里定位目录。", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-reconnect-1", reply: "我先去外接硬盘里定位目录。", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-reconnect-1", reply: "我先去外接硬盘里定位目录。", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-reconnect-1", reply: "我先去外接硬盘里定位目录。\n我在等全盘结果返回。", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-reconnect-1", reply: "我先去外接硬盘里定位目录。\n我在等全盘结果返回。", isStreaming: true })
      .mockResolvedValueOnce({ unitKey: "assistant-reconnect-1", reply: "我先去外接硬盘里定位目录。\n我在等全盘结果返回。", isStreaming: true })
      .mockResolvedValueOnce({
        unitKey: "assistant-reconnect-1",
        reply: [
          "我先去外接硬盘里定位目录。",
          "我在等全盘结果返回。",
          "<qqmedia>/tmp/a.png</qqmedia>",
          "<qqmedia>/tmp/b.png</qqmedia>"
        ].join("\n"),
        isStreaming: false
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-reconnect-1",
        reply: [
          "我先去外接硬盘里定位目录。",
          "我在等全盘结果返回。",
          "<qqmedia>/tmp/a.png</qqmedia>",
          "<qqmedia>/tmp/b.png</qqmedia>"
        ].join("\n"),
        isStreaming: false
      });

    const driver = new CodexDesktopDriver(
      {
        connect: vi.fn().mockResolvedValue({
          appName: "Codex",
          browserVersion: "Codex/1.0",
          browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
        }),
        listTargets: vi.fn().mockResolvedValue([
          {
            id: "page-1",
            title: "Codex",
            type: "page",
            url: "app://codex"
          }
        ]),
        evaluateOnPage,
        dispatchKeyEvent: vi.fn().mockResolvedValue(undefined),
        insertText: vi.fn().mockResolvedValue(undefined)
      } as unknown as CdpSession,
      {
        replyPollAttempts: 12,
        replyPollIntervalMs: 0,
        replyStablePolls: 2,
        sleep: async () => undefined
      }
    );

    const binding = {
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "cdp-target:page-1"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-reconnecting-stream",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      senderId: "OPENID123",
      text: "帮我把图片都发给我",
      receivedAt: "2026-04-10T17:40:00.000Z"
    });

    const emitted: OutboundDraft[] = [];
    const finalDrafts = await driver.collectAssistantReply(binding, {
      onDraft: async (draft) => {
        emitted.push(draft);
      }
    });

    expect(emitted).toMatchObject([
      { text: "我先去外接硬盘里定位目录。" },
      { text: "我在等全盘结果返回。" },
      {
        text: "<qqmedia>/tmp/a.png</qqmedia>\n<qqmedia>/tmp/b.png</qqmedia>"
      }
    ]);
    expect(finalDrafts).toEqual([]);
    expect(evaluateOnPage).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("assistantStatusMatcher"),
      "page-1"
    );
  });

  it("does not timeout while the assistant remains streaming before a late qqmedia result arrives", async () => {
    const evaluateOnPage = vi
      .fn()
      .mockResolvedValueOnce({ reply: "old reply", isStreaming: false })
      .mockResolvedValueOnce({ ok: true, reason: "focused_input" })
      .mockResolvedValueOnce({ ok: true, reason: "clicked_send_button" })
      .mockResolvedValueOnce({
        unitKey: "assistant-long-running-1",
        reply: "我先开始生成图片。",
        mediaReferences: [],
        isStreaming: true
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-long-running-1",
        reply: "我先开始生成图片。",
        mediaReferences: [],
        isStreaming: true
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-long-running-1",
        reply: "我先开始生成图片。\n图片正在生成，我检查一下成品文件。",
        mediaReferences: [],
        isStreaming: true
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-long-running-1",
        reply: "我先开始生成图片。\n图片正在生成，我检查一下成品文件。",
        mediaReferences: [],
        isStreaming: true
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-long-running-1",
        reply: [
          "我先开始生成图片。",
          "图片正在生成，我检查一下成品文件。",
          "按你的要求生成好了：",
          "<qqmedia>/tmp/final-image.jpg</qqmedia>"
        ].join("\n"),
        mediaReferences: [],
        isStreaming: false
      })
      .mockResolvedValueOnce({
        unitKey: "assistant-long-running-1",
        reply: [
          "我先开始生成图片。",
          "图片正在生成，我检查一下成品文件。",
          "按你的要求生成好了：",
          "<qqmedia>/tmp/final-image.jpg</qqmedia>"
        ].join("\n"),
        mediaReferences: [],
        isStreaming: false
      });

    const driver = new CodexDesktopDriver(
      {
        connect: vi.fn().mockResolvedValue({
          appName: "Codex",
          browserVersion: "Codex/1.0",
          browserWebSocketUrl: "ws://127.0.0.1:9229/devtools/browser/abc"
        }),
        listTargets: vi.fn().mockResolvedValue([
          {
            id: "page-1",
            title: "Codex",
            type: "page",
            url: "app://codex"
          }
        ]),
        evaluateOnPage,
        dispatchKeyEvent: vi.fn().mockResolvedValue(undefined),
        insertText: vi.fn().mockResolvedValue(undefined)
      } as unknown as CdpSession,
      {
        replyPollAttempts: 2,
        replyPollIntervalMs: 0,
        replyStablePolls: 2,
        partialReplyStablePolls: 2,
        sleep: async () => undefined
      }
    );

    const binding = {
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "cdp-target:page-1"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-long-running-media",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      senderId: "OPENID123",
      text: "帮我生成图片并发给我",
      receivedAt: "2026-04-10T21:30:00.000Z"
    });

    const emitted: OutboundDraft[] = [];
    const finalDrafts = await driver.collectAssistantReply(binding, {
      onDraft: async (draft) => {
        emitted.push(draft);
      }
    });

    expect(emitted.length).toBeGreaterThanOrEqual(1);
    expect(emitted.at(-1)?.text).toContain("按你的要求生成好了：");
    expect(emitted.at(-1)?.text).toContain("<qqmedia>/tmp/final-image.jpg</qqmedia>");
    expect(finalDrafts).toEqual([]);
  });
});
