import { bootstrap } from "./bootstrap.js";

async function main() {
  const { config } = bootstrap();
  console.log("[qq-codex-bridge] bootstrapped", {
    databasePath: config.databasePath,
    codexApp: config.codexDesktop.appName
  });
}

main().catch((error) => {
  console.error("[qq-codex-bridge] fatal", error);
  process.exitCode = 1;
});
