  import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
  import fs from "node:fs";
  import path from "node:path";
  import { resolveDefaultCodexBinaryPath } from "../../../packages/adapters/codex-desktop/src/codex-app-server-driver.js";

  type FetchLike = typeof fetch;

  export type DevLaunchConfig = {
    appName: string;
    remoteDebuggingPort: number;
    startupTimeoutMs: number;
    startupPollIntervalMs: number;
    transport?: "auto" | "app-server" | "cdp";
    codexBinaryPath?: string | null;
  };

  type LaunchAppFn = (appName: string, port: number) => Promise<void> | void;

  type SpawnLike = (
    command: string,
    args: string[],
    options: SpawnOptions
  ) => Pick<ChildProcess, "unref">;

  type DevLaunchDeps = {
    fetchFn?: FetchLike;
    launchApp?: LaunchAppFn;
    sleep?: (ms: number) => Promise<void>;
    existsSyncFn?: (candidate: string) => boolean;
  };

type LaunchCodexDesktopDeps = {
  platform?: NodeJS.Platform;
  spawnFn?: SpawnLike;
  appExecutablePath?: string;
  existsSyncFn?: (candidate: string) => boolean;
};

type ResolveDarwinExecutableDeps = {
  searchRoots?: string[];
  existsSyncFn?: (candidate: string) => boolean;
};

export async function ensureCodexDesktopForDev(
  config: DevLaunchConfig,
  deps: DevLaunchDeps = {}
): Promise<{ launched: boolean }> {
  const fetchFn = deps.fetchFn ?? fetch;
  const launchApp = deps.launchApp ?? ((appName: string, port: number) => launchCodexDesktop(appName, port));
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  if (await isCdpReachable(config.remoteDebuggingPort, fetchFn)) {
    return { launched: false };
  }

  await launchApp(config.appName, config.remoteDebuggingPort);

  const deadline = Date.now() + config.startupTimeoutMs;
  while (Date.now() <= deadline) {
    if (await isCdpReachable(config.remoteDebuggingPort, fetchFn)) {
      return { launched: true };
    }

    await sleep(config.startupPollIntervalMs);
  }

  const transport = config.transport ?? "auto";
  if (transport !== "cdp") {
    const existsSync = deps.existsSyncFn ?? fs.existsSync;
    const binaryPath = config.codexBinaryPath ?? resolveDefaultCodexBinaryPath(existsSync);
    if (binaryPath && existsSync(binaryPath)) {
      console.warn(
        `[qq-codex-bridge] CDP endpoint on port ${config.remoteDebuggingPort} not reachable, but AppServer binary found at '${binaryPath}'. Proceeding with '${transport}' transport.`
      );
      return { launched: true };
    }
  }
  throw new Error(
    `Timed out waiting for Codex desktop CDP endpoint on port ${config.remoteDebuggingPort}`
  );
}

export function launchCodexDesktop(
  appName: string,
  port: number,
  deps: LaunchCodexDesktopDeps = {}
): void {
  const platform = deps.platform ?? process.platform;
  const spawnFn = deps.spawnFn ?? spawn;
  const portArg = `--remote-debugging-port=${port}`;

  if (platform === "darwin") {
    const executablePath =
      deps.appExecutablePath ??
      resolveDarwinAppExecutablePath(appName, { existsSyncFn: deps.existsSyncFn });
    const child = spawnFn(executablePath, [portArg], {
      detached: true,
      stdio: "ignore"
    });
    if (child && typeof (child as unknown as Record<string, unknown>).on === "function") {
      (child as unknown as { on: (event: string, listener: (err: Error) => void) => void }).on(
        "error",
        (err: Error) => {
          console.error(
            `[qq-codex-bridge] failed to launch desktop app at '${executablePath}':`,
            err.message
          );
        }
      );
    }
    child.unref();
    return;
  }

  if (platform === "linux") {
    const child = spawnFn(appName, [portArg], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    return;
  }

  throw new Error(`Unsupported platform for automatic Codex launch: ${platform}`);
}

async function isCdpReachable(port: number, fetchFn: FetchLike): Promise<boolean> {
  try {
    const response = await fetchFn(`http://127.0.0.1:${port}/json/version`);
    if (!response.ok) {
      return false;
    }

    const payload = (await response.json()) as {
      webSocketDebuggerUrl?: string;
    };

    return typeof payload.webSocketDebuggerUrl === "string" && payload.webSocketDebuggerUrl.length > 0;
  } catch {
    return false;
  }
}

export function resolveDarwinAppExecutablePath(
  appName: string,
  deps: ResolveDarwinExecutableDeps = {}
): string {
  const searchRoots = deps.searchRoots ?? [
    "/Applications",
    path.join(process.env.HOME ?? "", "Applications")
  ];
  const existsSyncFn = deps.existsSyncFn ?? fs.existsSync;
  const appNames = Array.from(new Set([appName, "ChatGPT", "Codex"]));

  for (const searchRoot of searchRoots) {
    for (const candidateName of appNames) {
      const candidate = path.join(
        searchRoot,
        `${candidateName}.app`,
        "Contents",
        "MacOS",
        candidateName
      );
      if (candidate && existsSyncFn(candidate)) {
        return candidate;
      }
    }
  }

  return path.join("/Applications", `${appName}.app`, "Contents", "MacOS", appName);
}
