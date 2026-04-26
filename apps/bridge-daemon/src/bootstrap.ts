import path from "node:path";
import { QqApiClient } from "../../../packages/adapters/qq/src/qq-api-client.js";
import { createQqChannelAdapter } from "../../../packages/adapters/qq/src/qq-channel-adapter.js";
import { FileQqGatewaySessionStore } from "../../../packages/adapters/qq/src/qq-gateway-session-store.js";
import {
  createWeixinChannelAdapter,
  type WeixinChannelAdapter
} from "../../../packages/adapters/weixin/src/weixin-channel-adapter.js";
import { CdpSession } from "../../../packages/adapters/codex-desktop/src/cdp-session.js";
import { CodexAppServerDriver } from "../../../packages/adapters/codex-desktop/src/codex-app-server-driver.js";
import { CodexDesktopAppUiNotificationForwarder } from "../../../packages/adapters/codex-desktop/src/codex-app-ui-notification-forwarder.js";
import { CodexLocalRolloutReader } from "../../../packages/adapters/codex-desktop/src/codex-local-rollout-reader.js";
import { CodexLocalSubmissionReader } from "../../../packages/adapters/codex-desktop/src/codex-local-submission-reader.js";
import { CodexDesktopDriver } from "../../../packages/adapters/codex-desktop/src/codex-desktop-driver.js";
import { BridgeSessionStatus } from "../../../packages/domain/src/session.js";
import type { TurnEvent } from "../../../packages/domain/src/message.js";
import { BridgeOrchestrator } from "../../../packages/orchestrator/src/bridge-orchestrator.js";
import { buildCodexInboundText } from "../../../packages/orchestrator/src/media-context.js";
import { formatQqOutboundDraft } from "../../../packages/orchestrator/src/qq-outbound-format.js";
import { enrichQqOutboundDraft } from "../../../packages/orchestrator/src/qq-outbound-draft.js";
import { shouldInjectQqbotSkillContext } from "../../../packages/orchestrator/src/qqbot-skill-context.js";
import { formatWeixinOutboundDraft } from "../../../packages/orchestrator/src/weixin-outbound-format.js";
import type {
  ConversationProviderPort,
  ConversationRunOptions,
  DesktopDriverPort
} from "../../../packages/ports/src/conversation.js";
import type { ChatEgressPort } from "../../../packages/ports/src/chat.js";
import type { DriverBinding } from "../../../packages/domain/src/driver.js";
import { SqliteTranscriptStore } from "../../../packages/store/src/message-repo.js";
import { SqliteSessionStore } from "../../../packages/store/src/session-repo.js";
import { createSqliteDatabase } from "../../../packages/store/src/sqlite.js";
import { loadConfigFromEnv } from "./config.js";
import { ChatgptDesktopProvider } from "../../../packages/adapters/chatgpt-desktop/src/bridge-provider.js";
import type { ChatgptDesktopDriver } from "../../../packages/adapters/chatgpt-desktop/src/driver.js";

const INTERNAL_TURN_EVENT_PATH = "/internal/codex-turn-events";

type BootstrapAdapters = {
  qq: ReturnType<typeof createQqChannelAdapter>;
  qqByAccountKey: Record<string, ReturnType<typeof createQqChannelAdapter>>;
  codexDesktop: DesktopDriverPort;
  weixin?: WeixinChannelAdapter;
  weixinByAccountKey: Record<string, WeixinChannelAdapter>;
};

type BootstrapOrchestrators = {
  qq: BridgeOrchestrator;
  weixin?: BridgeOrchestrator;
  byAccountKey: Record<string, BridgeOrchestrator>;
};

function formatDraftForQq(draft: Parameters<typeof formatQqOutboundDraft>[0]) {
  return formatQqOutboundDraft(enrichQqOutboundDraft(draft));
}

function formatDraftForWeixin(draft: Parameters<typeof formatWeixinOutboundDraft>[0]) {
  return formatWeixinOutboundDraft(enrichQqOutboundDraft(draft));
}

export function bootstrap() {
  const config = loadConfigFromEnv(process.env);
  const db = createSqliteDatabase(config.databasePath);
  const sessionStore = new SqliteSessionStore(db);
  const transcriptStore = new SqliteTranscriptStore(db);
  const runtimeDir = path.dirname(config.databasePath);
  const useDomTransport = process.env.CODEX_DESKTOP_TRANSPORT === "dom";
  const forwardAppServerUiEvents = process.env.CODEX_APP_SERVER_FORWARD_UI_EVENTS === "1";
  const cdpSession = new CdpSession({
    appName: config.codexDesktop.appName,
    remoteDebuggingPort: config.codexDesktop.remoteDebuggingPort
  });
  const legacyDomDriver = new CodexDesktopDriver(
    cdpSession,
    {
      localRolloutReader: new CodexLocalRolloutReader(),
      localSubmissionReader: new CodexLocalSubmissionReader()
    }
  );
  const codexDriver =
    useDomTransport
      ? legacyDomDriver
      : new CodexAppServerDriver({
          controlFallback: legacyDomDriver,
          notificationForwarder: forwardAppServerUiEvents
            ? new CodexDesktopAppUiNotificationForwarder(cdpSession)
            : null
        });
  const qqAdapters = config.qqBots.map((bot) => {
    const accountKey = `qqbot:${bot.accountId}`;
    const qqApiClient = new QqApiClient(bot.appId, bot.clientSecret, {
      markdownSupport: bot.markdownSupport
    });
    const qqGatewaySessionStore = new FileQqGatewaySessionStore(
      path.join(runtimeDir, `qq-gateway-session-${safePathSegment(bot.accountId)}.json`),
      accountKey,
      bot.appId
    );
    return {
      accountKey,
      adapter: createQqChannelAdapter({
        accountKey,
        appId: bot.appId,
        apiClient: qqApiClient,
        sessionStore: qqGatewaySessionStore,
        mediaDownloadDir: path.join(runtimeDir, "media", "qq", safePathSegment(bot.accountId)),
        stt: bot.stt
      }),
      sessionStore: qqGatewaySessionStore
    };
  });
  const defaultQqAdapter = qqAdapters[0];
  if (!defaultQqAdapter) {
    throw new Error("at least one QQ bot must be configured");
  }

  const adapters = {
    qq: defaultQqAdapter.adapter,
    qqByAccountKey: Object.fromEntries(qqAdapters.map((entry) => [entry.accountKey, entry.adapter])),
    codexDesktop: codexDriver
  };
  let desktopTurnTail = Promise.resolve();

  const runWithDesktopTurnLock = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = desktopTurnTail;
    let release!: () => void;
    desktopTurnTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  };

  const runCodexTurn = async <T>(work: () => Promise<T>): Promise<T> =>
    useDomTransport ? runWithDesktopTurnLock(work) : work();

  const codexConversationProvider = {
    runTurn: async (
      message: Parameters<BridgeOrchestrator["handleInbound"]>[0],
      options?: ConversationRunOptions
    ) =>
      runCodexTurn(async () => {
        await adapters.codexDesktop.ensureAppReady();
        const session = await sessionStore.getSession(message.sessionKey);
        const currentBinding = session
          && session.status === BridgeSessionStatus.Active
          ? {
              sessionKey: session.sessionKey,
              codexThreadRef: session.codexThreadRef
            }
          : null;
        const binding = await adapters.codexDesktop.openOrBindSession(
          message.sessionKey,
          currentBinding
        );
        const skillContextKey = shouldInjectQqbotSkillContext(message)
          ? `${binding.codexThreadRef ?? "unbound"}:qqbot-skill-v2`
          : null;
        const shouldIncludeSkillContext =
          skillContextKey !== null && session?.skillContextKey !== skillContextKey;
        await adapters.codexDesktop.sendUserMessage(binding, {
          ...message,
          text: buildCodexInboundText(message, {
            includeSkillContext: shouldIncludeSkillContext
          })
        });
        const stableBinding = await resolveStableBinding(adapters.codexDesktop, binding);
        if (session?.codexThreadRef !== stableBinding.codexThreadRef) {
          await sessionStore.updateBinding(message.sessionKey, stableBinding.codexThreadRef);
        }
        if (shouldIncludeSkillContext) {
          const stableSkillContextKey =
            skillContextKey !== null
              ? `${stableBinding.codexThreadRef ?? "unbound"}:qqbot-skill-v2`
              : null;
          await sessionStore.updateSkillContextKey(message.sessionKey, stableSkillContextKey);
        }
        const drafts = await adapters.codexDesktop.collectAssistantReply(stableBinding, {
          onDraft: options?.onDraft
            ? async (draft) => {
                await options.onDraft!({
                  ...draft,
                  replyToMessageId: message.messageId
                });
              }
            : undefined,
          onTurnEvent: async (event) => {
            await postTurnEvent(config.runtime.listenPort, {
              ...event,
              payload: {
                ...event.payload,
                replyToMessageId: message.messageId
              }
            });
          }
        });
        return drafts.map((draft) => ({
          ...draft,
          replyToMessageId: message.messageId
        }));
      })
  };

  const chatgptProvider = new ChatgptDesktopProvider({ outDir: "runtime/media/chatgpt" });

  const conversationProvider: ConversationProviderPort = {
    runTurn: async (message, options) => {
      const session = await sessionStore.getSession(message.sessionKey);
      const effectiveProvider = session?.conversationProvider ?? config.conversationProvider;
      if (effectiveProvider === "chatgpt-desktop") {
        return chatgptProvider.runTurn(message, options);
      }
      return codexConversationProvider.runTurn(message, options);
    }
  };

  const createChannelOrchestrator = (
    egress: ChatEgressPort,
    draftFormatter?: (
      draft: Parameters<typeof formatDraftForQq>[0]
    ) => ReturnType<typeof formatDraftForQq>
  ) =>
    new BridgeOrchestrator({
      sessionStore,
      transcriptStore,
      conversationProvider,
      qqEgress: egress,
      draftFormatter
    });

  const qqOrchestrators = Object.fromEntries(
    qqAdapters.map((entry) => [
      entry.accountKey,
      createChannelOrchestrator(entry.adapter.egress, formatDraftForQq)
    ])
  );

  const weixinAdapters = config.weixinAccounts
    .filter((account) => account.enabled && account.egressBaseUrl && account.egressToken)
    .map((account) => {
      const accountKey = `weixin:${account.accountId}`;
      return {
        accountKey,
        adapter: createWeixinChannelAdapter({
          accountKey,
          webhookPath: account.webhookPath,
          egressBaseUrl: account.egressBaseUrl!,
          egressToken: account.egressToken!
        })
      };
    });
  const weixinOrchestrators = Object.fromEntries(
    weixinAdapters.map((entry) => [
      entry.accountKey,
      createChannelOrchestrator(entry.adapter.egress, formatDraftForWeixin)
    ])
  );
  const defaultWeixinAdapter = weixinAdapters[0]?.adapter;
  const defaultWeixinOrchestrator = weixinAdapters[0]
    ? weixinOrchestrators[weixinAdapters[0].accountKey]
    : undefined;

  const channelOrchestrators: BootstrapOrchestrators = {
    qq: qqOrchestrators[defaultQqAdapter.accountKey],
    ...(defaultWeixinOrchestrator ? { weixin: defaultWeixinOrchestrator } : {}),
    byAccountKey: {
      ...qqOrchestrators,
      ...weixinOrchestrators
    }
  };

  const allAdapters: BootstrapAdapters = {
    ...adapters,
    ...(defaultWeixinAdapter ? { weixin: defaultWeixinAdapter } : {}),
    weixinByAccountKey: Object.fromEntries(
      weixinAdapters.map((entry) => [entry.accountKey, entry.adapter])
    )
  };

  return {
    config,
    db,
    sessionStore,
    transcriptStore,
    adapters: allAdapters,
    orchestrator: channelOrchestrators.qq,
    orchestrators: channelOrchestrators,
    qqGatewaySessionStore: defaultQqAdapter.sessionStore,
    chatgptDriver: chatgptProvider.desktopDriver
  };
}

async function resolveStableBinding(
  desktopDriver: Pick<DesktopDriverPort, "listRecentThreads">,
  binding: DriverBinding
): Promise<DriverBinding> {
  if (!binding.codexThreadRef?.startsWith("cdp-target:")) {
    return binding;
  }

  const currentThread = (await desktopDriver.listRecentThreads(200)).find(
    (thread) => thread.isCurrent
  );
  if (!currentThread) {
    return binding;
  }

  return {
    sessionKey: binding.sessionKey,
    codexThreadRef: currentThread.threadRef
  };
}

async function postTurnEvent(port: number, event: TurnEvent): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}${INTERNAL_TURN_EVENT_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(event)
    });
  } catch (error) {
    console.warn("[qq-codex-bridge] turn event callback failed", {
      turnId: event.turnId,
      sessionKey: event.sessionKey,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export { INTERNAL_TURN_EVENT_PATH };

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
}
