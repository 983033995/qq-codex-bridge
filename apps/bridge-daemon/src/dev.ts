import { loadConfigFromEnv } from "./config.js";
import { ensureCodexDesktopForDev } from "./dev-launch.js";
import { runBridgeDaemon } from "./main.js";

async function runDev() {
  const config = loadConfigFromEnv(process.env);
  const result = await ensureCodexDesktopForDev({
    appName: config.codexDesktop.appName,
    remoteDebuggingPort: config.codexDesktop.remoteDebuggingPort,
    startupTimeoutMs: Number(process.env.CODEX_CDP_STARTUP_TIMEOUT_MS ?? "15000"),
    startupPollIntervalMs: Number(process.env.CODEX_CDP_POLL_INTERVAL_MS ?? "500")
  });

  console.log("[qq-codex-bridge] codex desktop ready", {
    launched: result.launched,
    remoteDebuggingPort: config.codexDesktop.remoteDebuggingPort
  });

  await runBridgeDaemon();
}

runDev().catch((error) => {
  const cause = error instanceof Error ? error.cause : undefined;
  console.error("[qq-codex-bridge] fatal:", error instanceof Error ? error.message : String(error));
  if (cause !== undefined) {
    console.error("  caused by:", cause);
  }
  if (error instanceof Error && error.stack) {
    console.error("  stack:", error.stack);
  }
  process.exitCode = 1;
});
