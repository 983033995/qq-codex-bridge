import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PushApiClient } from "./push-api-client.js";
import { createPushMcpServer } from "./server.js";

type ResolvedMcpPushOptions = {
  baseUrl: string;
  token: string;
};

type ResolveMcpPushOptionsDeps = {
  isProcessRunning?: (pid: number) => boolean;
};

export function resolveMcpPushOptions(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  deps: ResolveMcpPushOptionsDeps = {}
): ResolvedMcpPushOptions {
  let baseUrl = env.MCP_PUSH_BASE_URL;
  let token = env.MCP_PUSH_TOKEN ?? env.PUSH_TOKEN;

  if (baseUrl && token) {
    return { baseUrl, token };
  }

  const searchDirs = [cwd];
  try {
    const pkgRoot = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
    if (pkgRoot && !searchDirs.includes(pkgRoot)) {
      searchDirs.push(pkgRoot);
    }
  } catch {
    // ignore
  }

  for (const dir of searchDirs) {
    const stateFile = path.join(dir, "runtime", "bridge-daemon-state.json");
    if (fs.existsSync(stateFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<string, unknown>;
        const pid = typeof state.pid === "number" ? state.pid : Number.NaN;
        const isProcessRunning = deps.isProcessRunning ?? isRunningProcess;
        if (!Number.isSafeInteger(pid) || pid <= 0 || !isProcessRunning(pid)) {
          continue;
        }
        if (!baseUrl && typeof state.baseUrl === "string" && state.baseUrl) {
          baseUrl = state.baseUrl;
        }
        if (!token && typeof state.pushToken === "string" && state.pushToken) {
          token = state.pushToken;
        }
      } catch {
        // ignore
      }
    }
    if (baseUrl && token) {
      return { baseUrl, token };
    }
  }

  for (const dir of searchDirs) {
    const envFile = path.join(dir, ".env");
    if (fs.existsSync(envFile)) {
      try {
        const fileContent = fs.readFileSync(envFile, "utf8");
        const parsedEnv = parseSimpleEnv(fileContent);
        if (!baseUrl) {
          const host = parsedEnv.QQ_CODEX_LISTEN_HOST ?? "127.0.0.1";
          const port = parsedEnv.QQ_CODEX_LISTEN_PORT ?? "3100";
          baseUrl = `http://${host}:${port}`;
        }
        if (!token) {
          token = parsedEnv.PUSH_TOKEN ?? parsedEnv.MCP_PUSH_TOKEN;
        }
      } catch {
        // ignore
      }
    }
    if (baseUrl && token) {
      return { baseUrl, token };
    }
  }

  return {
    baseUrl: baseUrl ?? "http://127.0.0.1:3100",
    token: token ?? ""
  };
}

function isRunningProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export async function runPushMcpServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const options = resolveMcpPushOptions(env);
  const client = new PushApiClient({
    baseUrl: options.baseUrl,
    token: options.token
  });
  await createPushMcpServer(client).connect(new StdioServerTransport());
}

function parseSimpleEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex > 0) {
      const key = trimmed.slice(0, eqIndex).trim();
      let val = trimmed.slice(eqIndex + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[key] = val;
    }
  }
  return result;
}

function findPackageRoot(startDir: string): string | null {
  let currentDir = startDir;
  while (true) {
    if (fs.existsSync(path.join(currentDir, "package.json"))) {
      return currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

void runPushMcpServer().catch((error) => {
  process.stderr.write(`[qq-codex-mcp] ${error instanceof Error ? error.message : String(error)}
`);
  process.exitCode = 1;
});
