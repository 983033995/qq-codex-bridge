import type {
  CodexControlState,
  CodexThreadSummary,
  DriverBinding
} from "../../../domain/src/driver.js";
import { DesktopDriverError } from "../../../domain/src/driver.js";
import type {
  InboundMessage,
  OutboundDraft
} from "../../../domain/src/message.js";
import type {
  ConversationRunOptions,
  DesktopDriverPort,
  DesktopTransportMode,
  DesktopTransportName,
  DesktopTransportStatus,
  DesktopTransportStatusPort
} from "../../../ports/src/conversation.js";
import { DesktopFeatureProbe } from "./feature-probe.js";

type UnifiedDesktopDriverOptions = {
  appServer: DesktopDriverPort;
  cdp: DesktopDriverPort;
  transport?: DesktopTransportMode;
  probeIntervalMs?: number;
  onTransportChanged?: (
    status: DesktopTransportStatus
  ) => Promise<void> | void;
};

type SessionTransportState = {
  transport: DesktopTransportName;
  binding: DriverBinding;
  messageAccepted: boolean;
};

export class UnifiedDesktopDriver
implements DesktopDriverPort, DesktopTransportStatusPort {
  private readonly configured: DesktopTransportMode;
  private readonly probe: DesktopFeatureProbe;
  private readonly sessionState = new Map<string, SessionTransportState>();
  private activeTransport: DesktopTransportName | null = null;
  private probePromise: Promise<DesktopTransportName> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private cdpTurnTail = Promise.resolve();
  private readonly cdpReleases = new Map<string, () => void>();

  constructor(private readonly options: UnifiedDesktopDriverOptions) {
    this.configured = options.transport ?? "auto";
    this.probe = new DesktopFeatureProbe({
      appServer: options.appServer,
      cdp: options.cdp,
      configured: this.configured
    });

    const intervalMs = Math.max(0, options.probeIntervalMs ?? 300_000);
    if (this.configured === "auto" && intervalMs > 0) {
      this.timer = setInterval(() => {
        void this.refreshPreferredTransport();
      }, intervalMs);
      this.timer.unref?.();
    }
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const release of this.cdpReleases.values()) {
      release();
    }
    this.cdpReleases.clear();
  }

  releaseSessionTurn(sessionKey: string): void {
    this.releaseCdpTurn(sessionKey);
  }

  getTransportStatus(): DesktopTransportStatus {
    return this.probe.getStatus();
  }

  async ensureAppReady(): Promise<void> {
    await this.ensureTransport();
  }

  async getControlState(binding: DriverBinding | null = null): Promise<CodexControlState> {
    const transport = await this.ensureTransport();
    return this.driver(transport).getControlState(binding);
  }

  async getQuotaSummary(): Promise<string | null> {
    const transport = await this.ensureTransport();
    return this.driver(transport).getQuotaSummary();
  }

  async switchModel(model: string): Promise<CodexControlState> {
    const transport = await this.ensureTransport();
    return this.driver(transport).switchModel(model);
  }

  async openOrBindSession(
    sessionKey: string,
    binding: DriverBinding | null
  ): Promise<DriverBinding> {
    const transport = await this.ensureTransport();
    if (transport === "cdp") {
      await this.acquireCdpTurn(sessionKey);
    }

    try {
      const resolved = await this.driver(transport).openOrBindSession(
        sessionKey,
        sanitizeBinding(binding, transport)
      );
      this.sessionState.set(sessionKey, {
        transport,
        binding: resolved,
        messageAccepted: false
      });
      return resolved;
    } catch (error) {
      this.releaseCdpTurn(sessionKey);
      if (transport === "app-server" && this.configured === "auto") {
        return this.openWithCdpFallback(sessionKey, binding, error);
      }
      throw error;
    }
  }

  async listRecentThreads(limit: number): Promise<CodexThreadSummary[]> {
    const transport = await this.ensureTransport();
    return this.driver(transport).listRecentThreads(limit);
  }

  async switchToThread(sessionKey: string, threadRef: string): Promise<DriverBinding> {
    const transport = await this.ensureTransport();
    if (transport === "cdp") {
      await this.acquireCdpTurn(sessionKey);
    }
    try {
      const binding = await this.driver(transport).switchToThread(sessionKey, threadRef);
      this.sessionState.set(sessionKey, {
        transport,
        binding,
        messageAccepted: false
      });
      return binding;
    } finally {
      this.releaseCdpTurn(sessionKey);
    }
  }

  async createThread(sessionKey: string, seedPrompt: string): Promise<DriverBinding> {
    const transport = await this.ensureTransport();
    if (transport === "cdp") {
      await this.acquireCdpTurn(sessionKey);
    }
    try {
      const binding = await this.driver(transport).createThread(sessionKey, seedPrompt);
      this.sessionState.set(sessionKey, {
        transport,
        binding,
        messageAccepted: false
      });
      return binding;
    } finally {
      this.releaseCdpTurn(sessionKey);
    }
  }

  async sendUserMessage(binding: DriverBinding, message: InboundMessage): Promise<void> {
    const state = this.sessionState.get(binding.sessionKey) ?? {
      transport: await this.ensureTransport(),
      binding,
      messageAccepted: false
    };

    try {
      await this.driver(state.transport).sendUserMessage(state.binding, message);
      state.messageAccepted = true;
      this.sessionState.set(binding.sessionKey, state);
    } catch (error) {
      if (
        state.transport !== "app-server"
        || state.messageAccepted
        || this.configured !== "auto"
        || !isSafePreSubmitFailure(error)
      ) {
        this.releaseCdpTurn(binding.sessionKey);
        throw error;
      }

      const fallbackBinding = await this.openWithCdpFallback(
        binding.sessionKey,
        binding,
        error
      );
      const fallbackState = this.sessionState.get(binding.sessionKey)!;
      binding.codexThreadRef = fallbackBinding.codexThreadRef;
      try {
        await this.options.cdp.sendUserMessage(fallbackBinding, message);
        fallbackState.messageAccepted = true;
      } catch (fallbackError) {
        this.releaseCdpTurn(binding.sessionKey);
        throw fallbackError;
      }
    }
  }

  async collectAssistantReply(
    binding: DriverBinding,
    options?: ConversationRunOptions
  ): Promise<OutboundDraft[]> {
    const state = this.sessionState.get(binding.sessionKey) ?? {
      transport: await this.ensureTransport(),
      binding,
      messageAccepted: true
    };

    try {
      return await this.driver(state.transport).collectAssistantReply(
        state.binding,
        options
      );
    } finally {
      state.messageAccepted = false;
      this.releaseCdpTurn(binding.sessionKey);
    }
  }

  async markSessionBroken(sessionKey: string, reason: string): Promise<void> {
    const state = this.sessionState.get(sessionKey);
    try {
      if (state) {
        await this.driver(state.transport).markSessionBroken(sessionKey, reason);
      } else {
        const transport = await this.ensureTransport();
        await this.driver(transport).markSessionBroken(sessionKey, reason);
      }
    } finally {
      this.sessionState.delete(sessionKey);
      this.releaseCdpTurn(sessionKey);
    }
  }

  private async ensureTransport(): Promise<DesktopTransportName> {
    if (this.activeTransport) {
      return this.activeTransport;
    }
    if (!this.probePromise) {
      this.probePromise = this.probe.probe().finally(() => {
        this.probePromise = null;
      });
    }
    return this.setActive(await this.probePromise);
  }

  private async refreshPreferredTransport(): Promise<void> {
    if (this.refreshPromise || this.probePromise) {
      return;
    }
    this.refreshPromise = (async () => {
      if (await this.probe.probeAppServer()) {
        await this.setActive("app-server");
      }
    })().finally(() => {
      this.refreshPromise = null;
    });
    await this.refreshPromise;
  }

  private async openWithCdpFallback(
    sessionKey: string,
    binding: DriverBinding | null,
    primaryError: unknown
  ): Promise<DriverBinding> {
    await this.acquireCdpTurn(sessionKey);
    try {
      await this.options.cdp.ensureAppReady();
      const fallbackBinding = await this.options.cdp.openOrBindSession(
        sessionKey,
        sanitizeBinding(binding, "cdp")
      );
      this.sessionState.set(sessionKey, {
        transport: "cdp",
        binding: fallbackBinding,
        messageAccepted: false
      });
      await this.setActive(
        "cdp",
        primaryError instanceof Error ? primaryError.message : String(primaryError)
      );
      return fallbackBinding;
    } catch (fallbackError) {
      this.releaseCdpTurn(sessionKey);
      throw fallbackError;
    }
  }

  private driver(transport: DesktopTransportName): DesktopDriverPort {
    return transport === "app-server" ? this.options.appServer : this.options.cdp;
  }

  private async setActive(
    transport: DesktopTransportName,
    error: string | null = null
  ): Promise<DesktopTransportName> {
    const changed = this.activeTransport !== transport;
    this.activeTransport = transport;
    this.probe.markActive(transport, error);
    if (changed) {
      await this.options.onTransportChanged?.(this.getTransportStatus());
    }
    return transport;
  }

  private async acquireCdpTurn(sessionKey: string): Promise<void> {
    if (this.cdpReleases.has(sessionKey)) {
      return;
    }
    const previous = this.cdpTurnTail;
    let release!: () => void;
    this.cdpTurnTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    this.cdpReleases.set(sessionKey, release);
  }

  private releaseCdpTurn(sessionKey: string): void {
    this.cdpReleases.get(sessionKey)?.();
    this.cdpReleases.delete(sessionKey);
  }
}

function sanitizeBinding(
  binding: DriverBinding | null,
  transport: DesktopTransportName
): DriverBinding | null {
  const threadRef = binding?.codexThreadRef;
  if (!binding || !threadRef) {
    return binding;
  }
  if (transport === "app-server" && threadRef.startsWith("cdp-target:")) {
    return null;
  }
  if (transport === "cdp" && threadRef.startsWith("codex-app-thread:")) {
    return null;
  }
  return binding;
}

function isSafePreSubmitFailure(error: unknown): boolean {
  return error instanceof DesktopDriverError
    && (
      error.reason === "app_not_ready"
      || error.reason === "session_not_found"
      || error.reason === "input_not_found"
    );
}
