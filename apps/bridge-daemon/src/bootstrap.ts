import path from "node:path";
import { QqApiClient } from "../../../packages/adapters/qq/src/qq-api-client.js";
import { createQqChannelAdapter } from "../../../packages/adapters/qq/src/qq-channel-adapter.js";
import { FileQqGatewaySessionStore } from "../../../packages/adapters/qq/src/qq-gateway-session-store.js";
import { CdpSession } from "../../../packages/adapters/codex-desktop/src/cdp-session.js";
import { CodexDesktopDriver } from "../../../packages/adapters/codex-desktop/src/codex-desktop-driver.js";
import { BridgeSessionStatus } from "../../../packages/domain/src/session.js";
import type { TurnEvent } from "../../../packages/domain/src/message.js";
import { BridgeOrchestrator } from "../../../packages/orchestrator/src/bridge-orchestrator.js";
import { buildCodexInboundText } from "../../../packages/orchestrator/src/media-context.js";
import { formatQqOutboundDraft } from "../../../packages/orchestrator/src/qq-outbound-format.js";
import { enrichQqOutboundDraft } from "../../../packages/orchestrator/src/qq-outbound-draft.js";
import { shouldInjectQqbotSkillContext } from "../../../packages/orchestrator/src/qqbot-skill-context.js";
import type { ConversationRunOptions } from "../../../packages/ports/src/conversation.js";
import { SqliteTranscriptStore } from "../../../packages/store/src/message-repo.js";
import { SqliteSessionStore } from "../../../packages/store/src/session-repo.js";
import { createSqliteDatabase } from "../../../packages/store/src/sqlite.js";
import { loadConfigFromEnv } from "./config.js";

const INTERNAL_TURN_EVENT_PATH = "/internal/codex-turn-events";

export function bootstrap() {
  const config = loadConfigFromEnv(process.env);
  const db = createSqliteDatabase(config.databasePath);
  const sessionStore = new SqliteSessionStore(db);
  const transcriptStore = new SqliteTranscriptStore(db);
  const qqApiClient = new QqApiClient(config.qqBot.appId, config.qqBot.clientSecret, {
    markdownSupport: config.qqBot.markdownSupport
  });
  const accountKey = "qqbot:default";
  const qqGatewaySessionStore = new FileQqGatewaySessionStore(
    path.join(path.dirname(config.databasePath), "qq-gateway-session.json"),
    accountKey,
    config.qqBot.appId
  );
  const adapters = {
    qq: createQqChannelAdapter({
      accountKey,
      appId: config.qqBot.appId,
      apiClient: qqApiClient,
      sessionStore: qqGatewaySessionStore,
      mediaDownloadDir: path.join(path.dirname(config.databasePath), "media"),
      stt: config.qqBot.stt
    }),
    codexDesktop: new CodexDesktopDriver(
      new CdpSession({
        appName: config.codexDesktop.appName,
        remoteDebuggingPort: config.codexDesktop.remoteDebuggingPort
      })
    )
  };

  const conversationProvider = {
    runTurn: async (
      message: Parameters<BridgeOrchestrator["handleInbound"]>[0],
      options?: ConversationRunOptions
    ) => {
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
      if (session?.codexThreadRef !== binding.codexThreadRef) {
        await sessionStore.updateBinding(message.sessionKey, binding.codexThreadRef);
      }
      if (shouldIncludeSkillContext) {
        await sessionStore.updateSkillContextKey(message.sessionKey, skillContextKey);
      }
      const drafts = await adapters.codexDesktop.collectAssistantReply(binding, {
        onDraft: options?.onDraft
          ? async (draft) => {
              await options.onDraft!(
                formatQqOutboundDraft(
                  enrichQqOutboundDraft({
                    ...draft,
                    replyToMessageId: message.messageId
                  })
                )
              );
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
      return drafts.map((draft) =>
        formatQqOutboundDraft(
          enrichQqOutboundDraft({
            ...draft,
            replyToMessageId: message.messageId
          })
        )
      );
    }
  };

  const orchestrator = new BridgeOrchestrator({
    sessionStore,
    transcriptStore,
    conversationProvider,
    qqEgress: adapters.qq.egress
  });

  return {
    config,
    db,
    sessionStore,
    transcriptStore,
    adapters,
    orchestrator,
    qqGatewaySessionStore
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
