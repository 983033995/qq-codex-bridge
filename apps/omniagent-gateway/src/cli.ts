import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { runGatewayMcpServer } from "../../mcp-server-vnext/src/index.js";
import {
  RuntimeManager,
  type RuntimeDiagnostic,
  type RuntimeStatus
} from "../../../packages/runtime-manager/src/index.js";

type RuntimeManagerPort = Pick<
  RuntimeManager,
  "ensureRunning" | "stop" | "restart" | "getStatus" | "doctor"
>;

export type GatewayCliDependencies = {
  runtime?: RuntimeManagerPort;
  writeStdout?: (line: string) => void;
  writeStderr?: (line: string) => void;
  runMcp?: (runtime: RuntimeManagerPort) => Promise<void>;
  openUrl?: (url: string) => Promise<void>;
};

export async function runGatewayCli(
  rawArgs: readonly string[],
  dependencies: GatewayCliDependencies = {}
): Promise<number> {
  const command = rawArgs.filter(Boolean)[0] ?? "help";
  const runtime = dependencies.runtime ?? new RuntimeManager();
  const writeStdout = dependencies.writeStdout ?? console.log;
  const writeStderr = dependencies.writeStderr ?? console.error;

  try {
    switch (command) {
      case "start":
        printStatus(writeStdout, await runtime.ensureRunning());
        return 0;
      case "stop":
        await runtime.stop();
        writeStdout("OmniAgent Gateway Runtime 已停止。");
        return 0;
      case "restart":
        printStatus(writeStdout, await runtime.restart());
        return 0;
      case "status":
        printStatus(writeStdout, await runtime.getStatus());
        return 0;
      case "doctor":
        printDiagnostics(writeStdout, await runtime.doctor());
        return 0;
      case "open": {
        const status = await runtime.ensureRunning();
        if (!status.baseUrl) throw new Error("Runtime 未返回 Control Center 地址");
        await (dependencies.openUrl ?? openLocalUrl)(status.baseUrl);
        writeStdout(`已打开 OmniAgent Gateway Control Center：${status.baseUrl}`);
        return 0;
      }
      case "mcp":
        await (dependencies.runMcp ?? runGatewayMcpServer)(runtime);
        return 0;
      case "help":
      case "-h":
      case "--help":
        printHelp(writeStdout);
        return 0;
      default:
        writeStderr(`未知命令：${rawArgs.join(" ")}`);
        printHelp(writeStdout);
        return 1;
    }
  } catch (error) {
    writeStderr(`[OmniAgent Gateway] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export async function runCliFromProcess(): Promise<void> {
  process.exitCode = await runGatewayCli(process.argv.slice(2));
}

function printStatus(write: (line: string) => void, status: RuntimeStatus): void {
  write(`Runtime：${status.state}`);
  write(status.message);
  if (status.pid) write(`PID：${status.pid}`);
  if (status.baseUrl) write(`Control Center：${status.baseUrl}`);
}

function printDiagnostics(write: (line: string) => void, diagnostics: RuntimeDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    write(`[${diagnostic.status}] ${diagnostic.message}`);
    if (diagnostic.suggestedAction) write(`  建议：${diagnostic.suggestedAction}`);
  }
}

function printHelp(write: (line: string) => void): void {
  write("OmniAgent Gateway");
  write("");
  write("用法：omniagent-gateway <command>");
  write("");
  write("命令：mcp | start | stop | restart | status | doctor | open");
  write("旧的 qq-codex-bridge 与 qq-codex-mcp 命令在 v0.3 兼容期继续可用。");
}

async function openLocalUrl(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("open", [url], { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void runCliFromProcess();
}
