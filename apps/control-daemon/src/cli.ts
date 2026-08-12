import { pathToFileURL } from "node:url";
import { runProductionControlDaemon } from "./runtime.js";

export async function runCliFromProcess(): Promise<void> {
  await runProductionControlDaemon();
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runCliFromProcess().catch((error) => {
    process.stderr.write(`[qq-codex-bridge-vnext] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
