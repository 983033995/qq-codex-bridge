import { pathToFileURL } from "node:url";
import { runWeixinWorker } from "./runtime.js";

export function runCliFromProcess(): void {
  runWeixinWorker();
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  try {
    runCliFromProcess();
  } catch (error) {
    process.stderr.write(`[qq-codex-bridge-vnext] weixin worker fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
