import { bootstrap } from "./bootstrap.js";
import { createQqWebhookServer } from "./http-server.js";

async function main() {
  const app = bootstrap();

  await app.adapters.qq.ingress.onMessage(async (message) => {
    await app.orchestrator.handleInbound(message);
  });

  const server = createQqWebhookServer({
    webhookPath: app.config.runtime.webhookPath,
    ingress: app.adapters.qq.ingress,
    onDispatchError: (error, payload) => {
      console.error("[qq-codex-bridge] webhook dispatch failed", {
        error,
        payload
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(app.config.runtime.listenPort, app.config.runtime.listenHost, () => {
      server.off("error", reject);
      resolve();
    });
  });

  console.log("[qq-codex-bridge] ready", {
    listenHost: app.config.runtime.listenHost,
    listenPort: app.config.runtime.listenPort,
    webhookPath: app.config.runtime.webhookPath
  });
}

main().catch((error) => {
  // Safe error serialization to avoid Node.js 24 console.error crash
  const cause = error instanceof Error ? error.cause : undefined;
  console.error("[qq-codex-bridge] fatal:", error.message ?? String(error));
  if (cause !== undefined) {
    console.error("  caused by:", cause);
  }
  if (error instanceof Error && error.stack) {
    console.error("  stack:", error.stack);
  }
  process.exitCode = 1;
});
