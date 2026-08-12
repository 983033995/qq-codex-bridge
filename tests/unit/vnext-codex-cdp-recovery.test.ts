import { describe, expect, it, vi } from "vitest";
import type { CodexThreadSummary, DriverBinding } from "../../packages/domain/src/driver.js";
import {
  MediaArtifactKind,
  type InboundMessage,
  type OutboundDraft
} from "../../packages/domain/src/message.js";
import {
  CdpRecoveryAdapter,
  CdpRecoveryError,
  type CdpRecoveryDesktopDriver
} from "../../packages/codex-cdp-recovery/src/index.js";

describe("vNext CDP Recovery adapter", () => {
  it("reports a reduced degraded capability set without full Codex actions", async () => {
    const adapter = createAdapter(new FakeRecoveryDriver());

    await expect(adapter.health()).resolves.toMatchObject({
      status: "degraded",
      code: "CDP_RECOVERY_ONLY",
      capabilities: {
        selectKnownThread: true,
        submitText: true,
        collectFinalReply: true,
        controlState: true,
        createThread: false,
        renameThread: false,
        forkThread: false,
        concurrentTurns: false,
        preciseTurnEvents: false,
        media: false
      }
    });
    expect("createThread" in adapter).toBe(false);
    expect("renameThread" in adapter).toBe(false);
    expect("forkThread" in adapter).toBe(false);
  });

  it("selects one known title, submits once, and maps only the final reply", async () => {
    const driver = new FakeRecoveryDriver();
    const adapter = createAdapter(driver);
    const handle = await adapter.startRecoveryTurn(input("thread-a", "Thread A", "message-a"));
    driver.complete(handle.turnId, "final A", ["/tmp/a.png", "/tmp/a.png"]);

    await expect(handle.completion).resolves.toEqual({
      threadId: "thread-a",
      turnId: "recovery-turn-1",
      finalText: "final A",
      mediaReferences: ["/tmp/a.png"]
    });
    expect(driver.selectedTitles).toEqual(["Thread A"]);
    expect(driver.submissions).toHaveLength(1);
    expect(driver.submissions[0]?.text).toBe("message-a");
  });

  it("holds a global mutex through final reply collection", async () => {
    const driver = new FakeRecoveryDriver();
    const adapter = createAdapter(driver);
    const first = await adapter.startRecoveryTurn(input("thread-a", "Thread A", "message-a"));
    const secondPromise = adapter.startRecoveryTurn(input("thread-b", "Thread B", "message-b"));
    await flushAsync();
    expect(driver.submissions.map((message) => message.text)).toEqual(["message-a"]);

    driver.complete(first.turnId, "final A");
    await first.completion;
    const second = await secondPromise;
    expect(driver.submissions.map((message) => message.text)).toEqual(["message-a", "message-b"]);
    driver.complete(second.turnId, "final B");
    await expect(second.completion).resolves.toMatchObject({ finalText: "final B" });
  });

  it("releases the mutex after a recovery reply failure without resubmitting", async () => {
    const driver = new FakeRecoveryDriver();
    const adapter = createAdapter(driver);
    const first = await adapter.startRecoveryTurn(input("thread-a", "Thread A", "message-a"));
    driver.fail(first.turnId, new Error("cdp disconnected after submission"));
    await expect(first.completion).rejects.toMatchObject({
      code: "reply_failed",
      accepted: true
    });

    const second = await adapter.startRecoveryTurn(input("thread-b", "Thread B", "message-b"));
    expect(driver.submissions.map((message) => message.text)).toEqual(["message-a", "message-b"]);
    driver.complete(second.turnId, "final B");
    await second.completion;
  });

  it("fails loudly for ambiguous titles and non-text content", async () => {
    const driver = new FakeRecoveryDriver();
    driver.threads.push({ ...driver.threads[0]!, threadRef: "ref-a-duplicate" });
    const adapter = createAdapter(driver);

    await expect(adapter.startRecoveryTurn(input("thread-a", "Thread A", "message-a")))
      .rejects.toMatchObject({ code: "thread_ambiguous", accepted: false });
    await expect(adapter.startRecoveryTurn({
      ...input("thread-a", "Thread A", "message-media"),
      content: {
        text: "with file",
        mentions: [],
        attachments: [{
          id: "file-1",
          kind: "file",
          localPath: "/tmp/file.txt",
          mimeType: "text/plain",
          size: 1
        }]
      }
    })).rejects.toEqual(expect.objectContaining({
      code: "unsupported_content",
      accepted: false
    }));
    expect(driver.submissions).toEqual([]);
  });
});

function input(threadId: string, threadTitle: string, text: string) {
  return {
    threadId,
    threadTitle,
    idempotencyKey: `key-${text}`,
    content: { text, mentions: [], attachments: [] }
  };
}

function createAdapter(driver: FakeRecoveryDriver): CdpRecoveryAdapter {
  let nextTurn = 1;
  driver.onSubmitted = (sessionKey) => {
    driver.bindTurn(sessionKey, `recovery-turn-${nextTurn}`);
  };
  return new CdpRecoveryAdapter(driver, {
    now: () => new Date("2026-08-10T06:00:00.000Z"),
    nextTurnId: () => `recovery-turn-${nextTurn++}`
  });
}

class FakeRecoveryDriver implements CdpRecoveryDesktopDriver {
  readonly threads: CodexThreadSummary[] = [
    summary("Thread A", "ref-a"),
    summary("Thread B", "ref-b")
  ];
  readonly selectedTitles: string[] = [];
  readonly submissions: InboundMessage[] = [];
  onSubmitted: ((sessionKey: string) => void) | null = null;
  private readonly bindings = new Map<string, DriverBinding>();
  private readonly turnBySession = new Map<string, string>();
  private readonly replies = new Map<string, Deferred<OutboundDraft[]>>();

  async ensureAppReady(): Promise<void> {}

  async listRecentThreads(limit: number): Promise<CodexThreadSummary[]> {
    return this.threads.slice(0, limit);
  }

  async switchToThread(sessionKey: string, threadRef: string): Promise<DriverBinding> {
    const thread = this.threads.find((candidate) => candidate.threadRef === threadRef);
    if (!thread) {
      throw new CdpRecoveryError("not found", "thread_not_found", false);
    }
    this.selectedTitles.push(thread.title);
    const binding = { sessionKey, codexThreadRef: threadRef };
    this.bindings.set(sessionKey, binding);
    return binding;
  }

  async submitUserMessageOnce(_binding: DriverBinding, message: InboundMessage): Promise<void> {
    this.submissions.push(structuredClone(message));
    this.replies.set(message.sessionKey, deferred<OutboundDraft[]>());
    this.onSubmitted?.(message.sessionKey);
  }

  async collectAssistantReply(binding: DriverBinding): Promise<OutboundDraft[]> {
    return this.replies.get(binding.sessionKey)!.promise;
  }

  async getControlState() {
    return {
      model: "gpt-test",
      reasoningEffort: "high",
      workspace: null,
      branch: null,
      permissionMode: null,
      quotaSummary: null
    };
  }

  bindTurn(sessionKey: string, turnId: string): void {
    this.turnBySession.set(turnId, sessionKey);
  }

  complete(turnId: string, text: string, mediaReferences: string[] = []): void {
    const sessionKey = this.turnBySession.get(turnId)!;
    this.replies.get(sessionKey)!.resolve([{
      draftId: `draft-${turnId}`,
      turnId,
      sessionKey,
      text,
      mediaArtifacts: mediaReferences.map((reference) => ({
        kind: MediaArtifactKind.Image,
        sourceUrl: reference,
        localPath: reference,
        mimeType: "image/png",
        fileSize: 1,
        originalName: "image.png"
      })),
      createdAt: "2026-08-10T06:00:00.000Z"
    }]);
  }

  fail(turnId: string, error: unknown): void {
    const sessionKey = this.turnBySession.get(turnId)!;
    this.replies.get(sessionKey)!.reject(error);
  }
}

function summary(title: string, threadRef: string): CodexThreadSummary {
  return {
    index: 1,
    title,
    projectName: null,
    relativeTime: "now",
    isCurrent: false,
    threadRef
  };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
