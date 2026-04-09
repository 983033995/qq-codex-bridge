import { QqApiClient } from "../../../packages/adapters/qq/src/qq-api-client.js";
import { createQqChannelAdapter } from "../../../packages/adapters/qq/src/qq-channel-adapter.js";
import { CdpSession } from "../../../packages/adapters/codex-desktop/src/cdp-session.js";
import { CodexDesktopDriver } from "../../../packages/adapters/codex-desktop/src/codex-desktop-driver.js";
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
  const adapters = {
    qq: createQqChannelAdapter(qqApiClient),
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
      const binding = await adapters.codexDesktop.openOrBindSession(message.sessionKey, null);
      await adapters.codexDesktop.sendUserMessage(binding, message);
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
