import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { loadWeixinGatewayConfigFromEnv } from "./config.js";
import { createWeixinGatewayServer } from "./server.js";

type CliDeps = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  packageRoot?: string;
  loadEnvFile?: (filePath: string) => void;
  writeStdout?: (line: string) => void;
  writeStderr?: (line: string) => void;
};

export async function runCli(rawArgs: string[], deps: CliDeps = {}): Promise<number> {
  const args = rawArgs.filter((arg) => arg.length > 0);
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const packageRoot = deps.packageRoot ?? findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
  const writeStdout = deps.writeStdout ?? ((line: string) => console.log(line));
  const writeStderr = deps.writeStderr ?? ((line: string) => console.error(line));

  if (args[0] === "init") {
    return initEnvTemplate({ cwd, packageRoot, writeStdout, writeStderr });
  }

  if (args[0] === "help" || args[0] === "-h" || args[0] === "--help") {
    printHelp(writeStdout);
    return 0;
  }

  if (args.length > 0) {
    writeStderr(`[qq-codex-weixin-gateway] 未知命令：${args.join(" ")}`);
    printHelp(writeStdout);
    return 1;
  }

  const envFilePath = path.join(cwd, ".env");
  if (fs.existsSync(envFilePath)) {
    const loadEnvFile = deps.loadEnvFile ?? process.loadEnvFile.bind(process);
    loadEnvFile(envFilePath);
  }

  try {
    const config = loadWeixinGatewayConfigFromEnv(env);
    const server = createWeixinGatewayServer({ config });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.listenPort, config.listenHost, () => {
        server.off("error", reject);
        resolve();
      });
    });

    writeStdout(
      `[qq-codex-weixin-gateway] ready { listenHost: ${config.listenHost}, listenPort: ${config.listenPort}, bridgeWebhook: ${config.bridgeBaseUrl}${config.bridgeWebhookPath} }`
    );
    return 0;
  } catch (error) {
    if (error instanceof ZodError) {
      writeStderr(`[qq-codex-weixin-gateway] 配置无效：${error.issues.map((issue) => issue.message).join("; ")}`);
      return 1;
    }

    writeStderr(
      `[qq-codex-weixin-gateway] fatal: ${error instanceof Error ? error.message : String(error)}`
    );
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
  const targetPath = path.join(options.cwd, ".env.weixin-gateway");
  if (fs.existsSync(targetPath)) {
    options.writeStderr(`[qq-codex-weixin-gateway] 配置文件已存在：${targetPath}`);
    return 1;
  }

  const template = [
    "WEIXIN_GATEWAY_LISTEN_HOST=127.0.0.1",
    "WEIXIN_GATEWAY_LISTEN_PORT=3200",
    "WEIXIN_GATEWAY_BRIDGE_BASE_URL=http://127.0.0.1:3100",
    "WEIXIN_GATEWAY_BRIDGE_WEBHOOK_PATH=/webhooks/weixin",
    "WEIXIN_GATEWAY_EXPECTED_TOKEN=your-token",
    "WEIXIN_GATEWAY_MESSAGE_STORE_PATH=runtime/weixin-gateway-messages.ndjson",
    "WEIXIN_GATEWAY_RECENT_MESSAGE_LIMIT=100",
    ""
  ].join("\n");
  fs.writeFileSync(targetPath, template, "utf8");

  options.writeStdout(`[qq-codex-weixin-gateway] 已生成参考配置：${targetPath}`);
  options.writeStdout("[qq-codex-weixin-gateway] 你也可以直接把这些变量写进项目根目录的 .env。");
  return 0;
}

function printHelp(writeStdout: (line: string) => void) {
  writeStdout("qq-codex-weixin-gateway");
  writeStdout("");
  writeStdout("用法：");
  writeStdout("  qq-codex-weixin-gateway        启动参考微信文本网关");
  writeStdout("  qq-codex-weixin-gateway init   生成 .env.weixin-gateway 模板");
  writeStdout("  qq-codex-weixin-gateway help   查看帮助");
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
