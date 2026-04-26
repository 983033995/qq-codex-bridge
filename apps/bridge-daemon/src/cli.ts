import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { loadConfigFromEnv } from "./config.js";
import { ensureCodexDesktopForDev, type DevLaunchConfig } from "./dev-launch.js";
import { runBridgeDaemon } from "./main.js";

type CliDeps = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  packageRoot?: string;
  loadEnvFile?: (filePath: string) => void;
  ensureCodexDesktop?: (config: DevLaunchConfig) => Promise<{ launched: boolean }>;
  runBridgeDaemon?: () => Promise<{ channels: string[] } | void>;
  writeStdout?: (line: string) => void;
  writeStderr?: (line: string) => void;
};

const REQUIRED_ENV_MAP: Record<string, string> = {
  "qqBot.appId": "QQBOT_APP_ID",
  "qqBot.clientSecret": "QQBOT_CLIENT_SECRET",
  "codexDesktop.appName": "CODEX_APP_NAME",
  "codexDesktop.remoteDebuggingPort": "CODEX_REMOTE_DEBUGGING_PORT"
};

export async function runCli(rawArgs: string[], deps: CliDeps = {}): Promise<number> {
  const args = normalizeArgs(rawArgs);
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const packageRoot = deps.packageRoot ?? findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
  const writeStdout = deps.writeStdout ?? ((line: string) => console.log(line));
  const writeStderr = deps.writeStderr ?? ((line: string) => console.error(line));
  const ensureDesktop = deps.ensureCodexDesktop ?? ensureCodexDesktopForDev;
  const startBridge = deps.runBridgeDaemon ?? runBridgeDaemon;

  if (args[0] === "init") {
    return initEnvTemplate({
      cwd,
      packageRoot,
      writeStdout,
      writeStderr
    });
  }

  if (args[0] === "help" || args[0] === "-h" || args[0] === "--help") {
    printHelp(writeStdout);
    return 0;
  }

  if (args.length > 0) {
    writeStderr(`[qq-codex-bridge] 未知命令：${args.join(" ")}`);
    printHelp(writeStdout);
    return 1;
  }

  const envFilePath = path.join(cwd, ".env");
  if (fs.existsSync(envFilePath)) {
    const loadEnvFile = deps.loadEnvFile ?? process.loadEnvFile.bind(process);
    loadEnvFile(envFilePath);
  }

  try {
    const config = loadConfigFromEnv(env);
    const result = await ensureDesktop({
      appName: config.codexDesktop.appName,
      remoteDebuggingPort: config.codexDesktop.remoteDebuggingPort,
      startupTimeoutMs: Number(env.CODEX_CDP_STARTUP_TIMEOUT_MS ?? "15000"),
      startupPollIntervalMs: Number(env.CODEX_CDP_POLL_INTERVAL_MS ?? "500")
    });

    writeStdout(
      `[qq-codex-bridge] codex desktop ready { launched: ${String(result.launched)}, remoteDebuggingPort: ${config.codexDesktop.remoteDebuggingPort} }`
    );

    const runtime = await startBridge();
    const channels = Array.isArray((runtime as { channels?: string[] } | undefined)?.channels)
      ? (runtime as { channels: string[] }).channels
      : ["qq"];
    writeStdout(`[qq-codex-bridge] channels active: ${channels.join(", ")}`);
    return 0;
  } catch (error) {
    if (error instanceof ZodError) {
      writeStderr(formatConfigError(error, cwd));
      return 1;
    }

    const cause = error instanceof Error ? error.cause : undefined;
    writeStderr(`[qq-codex-bridge] fatal: ${error instanceof Error ? error.message : String(error)}`);
    if (cause !== undefined) {
      writeStderr(`  caused by: ${String(cause)}`);
    }
    if (error instanceof Error && error.stack) {
      writeStderr(`  stack: ${error.stack}`);
    }
    return 1;
  }
}

export async function runCliFromProcess() {
  process.exitCode = await runCli(process.argv.slice(2));
}

function initEnvTemplate(options: {
  cwd: string;
  packageRoot: string;
  writeStdout: (line: string) => void;
  writeStderr: (line: string) => void;
}) {
  const targetPath = path.join(options.cwd, ".env");
  if (fs.existsSync(targetPath)) {
    options.writeStderr(`[qq-codex-bridge] .env 已存在：${targetPath}`);
    options.writeStderr("[qq-codex-bridge] 如需重新生成，请先手动备份或删除现有文件。");
    return 1;
  }

  const templatePath = path.join(options.packageRoot, ".env.example");
  const template = fs.readFileSync(templatePath, "utf8");
  fs.writeFileSync(targetPath, template, "utf8");

  options.writeStdout(`[qq-codex-bridge] 已生成配置模板：${targetPath}`);
  options.writeStdout("[qq-codex-bridge] 请先填写 QQBOT_APP_ID 和 QQBOT_CLIENT_SECRET，再执行 `qq-codex-bridge`。");
  return 0;
}

function printHelp(writeStdout: (line: string) => void) {
  writeStdout("qq-codex-bridge");
  writeStdout("");
  writeStdout("用法：");
  writeStdout("  qq-codex-bridge        启动桥接守护进程");
  writeStdout("  qq-codex-bridge init   在当前目录生成 .env");
  writeStdout("  qq-codex-bridge help   查看帮助");
}

function formatConfigError(error: ZodError, cwd: string) {
  const missingVars = Array.from(
    new Set(
      error.issues
        .map((issue) => REQUIRED_ENV_MAP[issue.path.join(".")])
        .filter((value): value is string => Boolean(value))
    )
  );

  const lines = [`[qq-codex-bridge] 配置不完整，无法启动。`];

  if (missingVars.length > 0) {
    lines.push(`[qq-codex-bridge] 缺少或无效的关键变量：${missingVars.join(", ")}`);
  }

  lines.push(`[qq-codex-bridge] 请在当前目录准备 .env：${path.join(cwd, ".env")}`);
  lines.push("[qq-codex-bridge] 如果还没有配置文件，可先执行：qq-codex-bridge init");
  return lines.join("\n");
}

function normalizeArgs(args: string[]) {
  return args.filter((arg) => arg.length > 0);
}

function findPackageRoot(startDir: string) {
  let currentDir = startDir;

  while (true) {
    if (fs.existsSync(path.join(currentDir, "package.json"))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Unable to locate package root from ${startDir}`);
    }
    currentDir = parentDir;
  }
}

const isEntrypoint = (() => {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }

  try {
    return fileURLToPath(import.meta.url) === path.resolve(entrypoint);
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  void runCliFromProcess();
}
