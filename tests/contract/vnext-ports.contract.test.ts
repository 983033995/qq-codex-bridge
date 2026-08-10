import {
  channelPortContract,
  codexPortContract,
  secretStorePortContract,
  type ChannelPortHarness
} from "./support/vnext-port-contracts.js";
import type {
  ChannelHealth,
  ChannelPort,
  CodexCapabilities,
  CodexControlState,
  CodexHealth,
  CodexPort,
  CodexTurnHandle,
  CreateThreadInput,
  DeliveryRequest,
  DeliveryResult,
  ListThreadsInput,
  SecretStorePort,
  StartCodexTurnInput
} from "../../packages/ports/src/vnext/index.js";
import type {
  CodexThread,
  InboundEnvelope
} from "../../packages/domain/src/vnext/index.js";

channelPortContract("fake", createFakeChannelHarness);
codexPortContract("fake", () => new FakeCodexPort());
secretStorePortContract("memory", () => new MemorySecretStore());

function createFakeChannelHarness(): ChannelPortHarness {
  const port = new FakeChannelPort();
  return {
    port,
    emitInbound: (message) => port.emitInbound(message),
    deliveries: port.deliveries
  };
}

class FakeChannelPort implements ChannelPort {
  readonly deliveries: DeliveryRequest[] = [];
  private handler: ((message: InboundEnvelope) => Promise<void>) | null = null;
  private running = false;

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async health(): Promise<ChannelHealth> {
    return {
      component: "fake-channel",
      accountId: "weixin:personal" as ChannelHealth["accountId"],
      status: this.running ? "ready" : "offline",
      message: this.running ? "ready" : "stopped",
      since: "2026-08-10T06:00:00.000Z"
    };
  }

  onMessage(handler: (message: InboundEnvelope) => Promise<void>): void {
    this.handler = handler;
  }

  async deliver(input: DeliveryRequest): Promise<DeliveryResult> {
    this.deliveries.push(input);
    return { ok: true, providerMessageId: "provider-out-1" };
  }

  async emitInbound(message: InboundEnvelope): Promise<void> {
    if (!this.handler) {
      throw new Error("No inbound handler registered");
    }
    await this.handler(message);
  }
}

class FakeCodexPort implements CodexPort {
  private readonly threads: CodexThread[] = [];
  private nextThreadId = 1;
  private nextTurnId = 1;

  async health(): Promise<CodexHealth> {
    return {
      component: "fake-codex",
      status: "ready",
      message: "ready",
      since: "2026-08-10T06:00:00.000Z",
      capabilities: capabilities()
    };
  }

  async listThreads(input: ListThreadsInput): Promise<CodexThread[]> {
    return this.threads.slice(0, input.limit);
  }

  async createThread(input: CreateThreadInput): Promise<CodexThread> {
    const thread: CodexThread = {
      threadId: `thread-${this.nextThreadId++}`,
      title: input.title ?? "Untitled",
      projectName: null,
      updatedAt: "2026-08-10T06:00:00.000Z"
    };
    this.threads.unshift(thread);
    return thread;
  }

  async renameThread(threadId: string, title: string): Promise<void> {
    const thread = this.requireThread(threadId);
    thread.title = title;
  }

  async forkThread(threadId: string): Promise<CodexThread> {
    const source = this.requireThread(threadId);
    return this.createThread({ title: `${source.title} (fork)` });
  }

  async startTurn(input: StartCodexTurnInput): Promise<CodexTurnHandle> {
    this.requireThread(input.threadId);
    const turnId = `turn-${this.nextTurnId++}`;
    return {
      threadId: input.threadId,
      turnId,
      acceptedAt: "2026-08-10T06:00:00.000Z",
      completion: Promise.resolve({
        threadId: input.threadId,
        turnId,
        finalText: "ok",
        mediaReferences: []
      })
    };
  }

  async interruptTurn(threadId: string, _turnId: string): Promise<void> {
    this.requireThread(threadId);
  }

  async getControlState(): Promise<CodexControlState> {
    return { model: "fake", reasoningEffort: null, quotaSummary: null };
  }

  async switchModel(model: string): Promise<CodexControlState> {
    return { model, reasoningEffort: null, quotaSummary: null };
  }

  private requireThread(threadId: string): CodexThread {
    const thread = this.threads.find((candidate) => candidate.threadId === threadId);
    if (!thread) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    return thread;
  }
}

class MemorySecretStore implements SecretStorePort {
  private readonly values = new Map<string, string>();

  async get(ref: string): Promise<string | null> {
    return this.values.get(ref) ?? null;
  }

  async set(ref: string, value: string): Promise<void> {
    this.values.set(ref, value);
  }

  async delete(ref: string): Promise<void> {
    this.values.delete(ref);
  }
}

function capabilities(): CodexCapabilities {
  return {
    listThreads: true,
    createThread: true,
    renameThread: true,
    forkThread: true,
    concurrentThreads: true,
    media: true
  };
}
