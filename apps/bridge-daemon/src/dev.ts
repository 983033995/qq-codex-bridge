import { loadConfigFromEnv } from "./config.js";
import { ensureCodexDesktopForDev } from "./dev-launch.js";
import { runBridgeDaemon } from "./main.js";

async function runDev() {
  const config = loadConfigFromEnv(process.env);
  const result = await ensureCodexDesktopForDev({
    appName: config.codexDesktop.appName,
    remoteDebuggingPort: config.codexDesktop.remoteDebuggingPort,
    startupTimeoutMs: Number(process.env.CODEX_CDP_STARTUP_TIMEOUT_MS ?? "15000"),
    startupPollIntervalMs: Number(process.env.CODEX_CDP_POLL_INTERVAL_MS ?? "500"),
    transport: config.desktopDriver.transport
  });

  console.log("[qq-codex-bridge] codex desktop ready", {
    launched: result.launched,
    remoteDebuggingPort: config.codexDesktop.remoteDebuggingPort
  });

  const runtime = await runBridgeDaemon();
  registerShutdownSignals(runtime);
}

/**
 * Ensures Ctrl+C / `kill` gracefully tears down the bridge, including the
 * managed Codex app-server child process this driver spawns. Without this,
 * that process is orphaned on every restart and keeps running indefinitely.
 */
function registerShutdownSignals(runtime: { shutdown(): Promise<void> }): void {
  let shuttingDown = false;
  const handle = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[qq-codex-bridge] received ${signal}, shutting down...`);
    runtime
      .shutdown()
      .catch((error) => {
        console.error("[qq-codex-bridge] error during shutdown:", error);
      })
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", handle);
  process.on("SIGTERM", handle);
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
