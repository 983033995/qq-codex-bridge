import { bootstrap } from "./bootstrap.js";

async function main() {
  const app = bootstrap();

  await app.adapters.qq.ingress.onMessage(async (message) => {
    await app.orchestrator.handleInbound(message);
  });

  console.log("[qq-codex-bridge] ready");
}

main().catch((error) => {
  console.error("[qq-codex-bridge] fatal", error);
  process.exitCode = 1;
});
