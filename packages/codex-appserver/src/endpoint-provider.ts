import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type AppServerEndpoint = {
  url: string;
  managed: boolean;
};

export interface AppServerEndpointProvider {
  resolve(): Promise<AppServerEndpoint>;
  dispose(): Promise<void> | void;
}

export type DefaultAppServerEndpointProviderOptions = {
  externalUrl?: string | null;
  codexBinaryPath?: string;
  discover?: () => Promise<string[]>;
  spawnFn?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions
  ) => ChildProcess;
  getFreePort?: () => Promise<number>;
};

export class DefaultAppServerEndpointProvider implements AppServerEndpointProvider {
  private readonly externalUrl: string | null;
  private readonly codexBinaryPath: string;
  private readonly discover: () => Promise<string[]>;
  private readonly spawnFn: NonNullable<DefaultAppServerEndpointProviderOptions["spawnFn"]>;
  private readonly getFreePort: () => Promise<number>;
  private managedProcess: ChildProcess | null = null;
  private managedUrl: string | null = null;

  constructor(options: DefaultAppServerEndpointProviderOptions = {}) {
    this.externalUrl = options.externalUrl ? validateLocalAppServerUrl(options.externalUrl) : null;
    this.codexBinaryPath = options.codexBinaryPath ?? resolveDefaultCodexBinaryPath();
    this.discover = options.discover ?? discoverRunningAppServerUrls;
    this.spawnFn = options.spawnFn ?? ((command, args, spawnOptions) =>
      spawn(command, [...args], spawnOptions));
    this.getFreePort = options.getFreePort ?? findFreeLoopbackPort;
  }

  async resolve(): Promise<AppServerEndpoint> {
    if (this.externalUrl) {
      return { url: this.externalUrl, managed: false };
    }
    if (this.managedUrl && this.managedProcess && this.managedProcess.exitCode === null) {
      return { url: this.managedUrl, managed: true };
    }

    const discovered = await this.discover().catch(() => []);
    if (discovered.length > 0) {
      return { url: validateLocalAppServerUrl(discovered[0]!), managed: false };
    }

    return this.startManaged();
  }

  dispose(): void {
    const child = this.managedProcess;
    this.managedProcess = null;
    this.managedUrl = null;
    if (child && child.exitCode === null && !child.killed) {
      child.kill();
    }
  }

  private async startManaged(): Promise<AppServerEndpoint> {
    if (!existsSync(this.codexBinaryPath)) {
      throw new Error(`Codex binary not found: ${this.codexBinaryPath}`);
    }
    const port = await this.getFreePort();
    const url = `ws://127.0.0.1:${port}`;
    const child = this.spawnFn(
      this.codexBinaryPath,
      ["app-server", "--listen", url, "-c", "analytics.enabled=false"],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    child.once("exit", () => {
      if (this.managedProcess === child) {
        this.managedProcess = null;
        this.managedUrl = null;
      }
    });
    child.once("error", () => {
      if (this.managedProcess === child) {
        this.managedProcess = null;
        this.managedUrl = null;
      }
    });
    child.stderr?.on("data", () => {
      // Stderr is intentionally drained. Runtime logging is owned by the
      // observability adapter, not this endpoint resolver.
    });
    this.managedProcess = child;
    this.managedUrl = url;
    return { url, managed: true };
  }
}

export async function discoverRunningAppServerUrls(): Promise<string[]> {
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "command="], {
    maxBuffer: 2 * 1024 * 1024
  });
  return discoverRunningAppServerUrlsFromProcessList(stdout);
}

export function discoverRunningAppServerUrlsFromProcessList(processList: string): string[] {
  const results: string[] = [];
  for (const line of processList.split(/\r?\n/)) {
    if (!/(?:^|\s)app-server(?:\s|$)/.test(line)) {
      continue;
    }
    const match = line.match(/--listen(?:=|\s+)(ws:\/\/[^\s]+)/);
    if (!match?.[1]) {
      continue;
    }
    try {
      results.push(validateLocalAppServerUrl(match[1]));
    } catch {
      // Ignore non-loopback or malformed process arguments.
    }
  }
  return [...new Set(results)];
}

export function validateLocalAppServerUrl(value: string): string {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "ws:"
    || url.username
    || url.password
    || !(
      hostname === "localhost"
      || hostname === "::1"
      || hostname === "[::1]"
      || hostname.startsWith("127.")
    )
  ) {
    throw new Error("Codex AppServer URL must be a credential-free loopback ws:// URL");
  }
  return url.toString().replace(/\/$/, "");
}

export function resolveDefaultCodexBinaryPath(): string {
  const candidates = [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex"
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

async function findFreeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a loopback port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}
