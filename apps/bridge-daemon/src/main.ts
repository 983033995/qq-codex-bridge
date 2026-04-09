import { pathToFileURL } from "node:url";
import { bootstrap } from "./bootstrap.js";
import { ThreadCommandHandler } from "./thread-command-handler.js";

export async function runBridgeDaemon() {
  const app = bootstrap();
  const threadCommandHandler = new ThreadCommandHandler({
    sessionStore: app.sessionStore,
    transcriptStore: app.transcriptStore,
    desktopDriver: app.adapters.codexDesktop,
    qqEgress: app.adapters.qq.egress
  });

  await app.adapters.qq.ingress.onMessage(async (message) => {
    const handled = await threadCommandHandler.handleIfCommand(message);
    if (handled) {
      return;
    }
    await app.orchestrator.handleInbound(message);
  });

  await app.adapters.qq.ingress.start();

  console.log("[qq-codex-bridge] ready", {
    transport: "qq-gateway-websocket",
    accountKey: "qqbot:default"
  });
}

function handleFatal(error: unknown) {
  const cause = error instanceof Error ? error.cause : undefined;
  console.error("[qq-codex-bridge] fatal:", error instanceof Error ? error.message : String(error));
  if (cause !== undefined) {
    console.error("  caused by:", cause);
  }
  if (error instanceof Error && error.stack) {
    console.error("  stack:", error.stack);
  }
  process.exitCode = 1;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runBridgeDaemon().catch(handleFatal);
}
