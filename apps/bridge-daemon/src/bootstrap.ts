import { QqApiClient } from "../../../packages/adapters/qq/src/qq-api-client.js";
import { createQqChannelAdapter } from "../../../packages/adapters/qq/src/qq-channel-adapter.js";
import { CdpSession } from "../../../packages/adapters/codex-desktop/src/cdp-session.js";
import { CodexDesktopDriver } from "../../../packages/adapters/codex-desktop/src/codex-desktop-driver.js";
import { BridgeSessionStatus } from "../../../packages/domain/src/session.js";
import { BridgeOrchestrator } from "../../../packages/orchestrator/src/bridge-orchestrator.js";
import { SqliteTranscriptStore } from "../../../packages/store/src/message-repo.js";
import { SqliteSessionStore } from "../../../packages/store/src/session-repo.js";
import { createSqliteDatabase } from "../../../packages/store/src/sqlite.js";
import { loadConfigFromEnv } from "./config.js";

export function bootstrap() {
  const config = loadConfigFromEnv(process.env);
  const db = createSqliteDatabase(config.databasePath);
  const sessionStore = new SqliteSessionStore(db);
  const transcriptStore = new SqliteTranscriptStore(db);
  const qqApiClient = new QqApiClient(config.qqBot.appId, config.qqBot.clientSecret);
  const accountKey = "qqbot:default";
  const adapters = {
    qq: createQqChannelAdapter({
      accountKey,
      apiClient: qqApiClient
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
      await adapters.codexDesktop.sendUserMessage(binding, message);
      if (session?.codexThreadRef !== binding.codexThreadRef) {
        await sessionStore.updateBinding(message.sessionKey, binding.codexThreadRef);
      }
      return adapters.codexDesktop.collectAssistantReply(binding);
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
    adapters,
    orchestrator
  };
}
