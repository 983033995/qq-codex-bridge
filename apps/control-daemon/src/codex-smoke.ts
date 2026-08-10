import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunCodexSmoke } from "../../../packages/application/src/index.js";
import { CodexAppServerAdapter } from "../../../packages/codex-appserver/src/index.js";

async function main(): Promise<void> {
  const runId = readArgument("--run-id") ?? defaultRunId();
  const adapter = new CodexAppServerAdapter({
    connectTimeoutMs: 10_000,
    requestTimeoutMs: 30_000
  });
  const probeDirectory = await mkdtemp(join(tmpdir(), "qq-codex-bridge-vnext-smoke-"));
  const probeFile = join(probeDirectory, "interrupt-ready");
  try {
    const report = await new RunCodexSmoke(adapter).execute({
      runId,
      cwd: process.cwd(),
      completionTimeoutMs: 180_000,
      interruptProbe: {
        prompt: `Use the terminal tool to run exactly: touch ${shellQuote(probeFile)} && sleep 30.`,
        waitUntilReady: (timeoutMs) => waitForFile(probeFile, timeoutMs)
      }
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await adapter.dispose();
    await rm(probeDirectory, { recursive: true, force: true });
  }
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Codex smoke interrupt readiness file was not created within ${timeoutMs}ms`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function readArgument(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = process.argv[index + 1]?.trim();
  if (!value) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function defaultRunId(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
