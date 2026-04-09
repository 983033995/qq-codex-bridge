import path from "node:path";
import { QqApiClient } from "../../../packages/adapters/qq/src/qq-api-client.js";
import { createQqChannelAdapter } from "../../../packages/adapters/qq/src/qq-channel-adapter.js";
import { FileQqGatewaySessionStore } from "../../../packages/adapters/qq/src/qq-gateway-session-store.js";
import { CdpSession } from "../../../packages/adapters/codex-desktop/src/cdp-session.js";
import { CodexDesktopDriver } from "../../../packages/adapters/codex-desktop/src/codex-desktop-driver.js";
import { BridgeSessionStatus } from "../../../packages/domain/src/session.js";
import { BridgeOrchestrator } from "../../../packages/orchestrator/src/bridge-orchestrator.js";
import { buildCodexInboundText } from "../../../packages/orchestrator/src/media-context.js";
import { formatQqOutboundDraft } from "../../../packages/orchestrator/src/qq-outbound-format.js";
import { enrichQqOutboundDraft } from "../../../packages/orchestrator/src/qq-outbound-draft.js";
import { shouldInjectQqbotSkillContext } from "../../../packages/orchestrator/src/qqbot-skill-context.js";
import { SqliteTranscriptStore } from "../../../packages/store/src/message-repo.js";
import { SqliteSessionStore } from "../../../packages/store/src/session-repo.js";
import { createSqliteDatabase } from "../../../packages/store/src/sqlite.js";
import { loadConfigFromEnv } from "./config.js";

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
      mediaDownloadDir: path.join(path.dirname(config.databasePath), "media")
    }),
    codexDesktop: new CodexDesktopDriver(
      new CdpSession({
        appName: config.codexDesktop.appName,
        remoteDebuggingPort: config.codexDesktop.remoteDebuggingPort
      })
    )
  };

  const conversationProvider = {
    runTurn: async (message: Parameters<BridgeOrchestrator["handleInbound"]>[0]) => {
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
      const drafts = await adapters.codexDesktop.collectAssistantReply(binding);
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
