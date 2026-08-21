import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { access, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateLegacyGatewayData, prepareGatewayDirectories } from "./migration.js";
import { resolveGatewayPaths, type GatewayPaths } from "./paths.js";

export type RuntimeState = "stopped" | "starting" | "ready" | "unhealthy";

export type RuntimeStatus = {
  state: RuntimeState;
  pid: number | null;
  baseUrl: string | null;
  startedAt: string | null;
  checkedAt: string;
  reused: boolean;
  message: string;
};

export type RuntimeDiagnostic = {
  code: string;
  status: "ok" | "warning" | "error";
  message: string;
  suggestedAction?: string;
};

type PersistedRuntimeState = {
  version: 1;
  pid: number;
  baseUrl: string;
  startedAt: string;
};

type SpawnRuntime = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => Pick<ChildProcess, "pid" | "unref">;

export type RuntimeManagerOptions = {
  root?: string;
  legacyRoot?: string;
  runtimeEntrypoint?: string;
  nodeExecutable?: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  pollIntervalMs?: number;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  now?: () => Date;
  sleep?: (durationMs: number) => Promise<void>;
  spawnRuntime?: SpawnRuntime;
  isProcessAlive?: (pid: number) => boolean;
  signalProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
  probeReady?: (baseUrl: string) => Promise<boolean>;
};

export class RuntimeManager {
  readonly paths: GatewayPaths;
  private readonly runtimeEntrypoint: string;
  private readonly nodeExecutable: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly startupTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly now: () => Date;
  private readonly sleep: (durationMs: number) => Promise<void>;
  private readonly spawnRuntime: SpawnRuntime;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly signalProcess: (pid: number, signal: NodeJS.Signals | 0) => void;
  private readonly probeReady: (baseUrl: string) => Promise<boolean>;
  private ensuring: Promise<RuntimeStatus> | null = null;

  constructor(options: RuntimeManagerOptions = {}) {
    this.paths = resolveGatewayPaths(options);
    this.runtimeEntrypoint = options.runtimeEntrypoint
      ?? fileURLToPath(new URL("../../../apps/control-daemon/src/cli.js", import.meta.url));
    this.nodeExecutable = options.nodeExecutable ?? process.execPath;
    this.env = options.env ?? process.env;
    this.startupTimeoutMs = positiveInteger(options.startupTimeoutMs ?? 30_000, "startupTimeoutMs");
    this.shutdownTimeoutMs = positiveInteger(options.shutdownTimeoutMs ?? 10_000, "shutdownTimeoutMs");
    this.pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 200, "pollIntervalMs");
    this.lockTimeoutMs = positiveInteger(options.lockTimeoutMs ?? 35_000, "lockTimeoutMs");
    this.staleLockMs = positiveInteger(options.staleLockMs ?? 60_000, "staleLockMs");
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));
    this.spawnRuntime = options.spawnRuntime ?? ((command, args, spawnOptions) =>
      spawn(command, [...args], spawnOptions));
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.signalProcess = options.signalProcess ?? ((pid, signal) => process.kill(pid, signal));
    this.probeReady = options.probeReady ?? probeRuntimeReady;
  }

  ensureRunning(): Promise<RuntimeStatus> {
    if (this.ensuring) return this.ensuring;
    this.ensuring = this.ensureRunningNow().finally(() => {
      this.ensuring = null;
    });
    return this.ensuring;
  }

  start(): Promise<RuntimeStatus> {
    return this.ensureRunning();
  }

  async stop(): Promise<void> {
    await prepareGatewayDirectories(this.paths);
    await this.withLock(async () => {
      const persisted = await this.readPersistedState();
      if (!persisted || !this.isProcessAlive(persisted.pid)) {
        await this.clearRuntimeState();
        return;
      }
      this.signalProcess(persisted.pid, "SIGTERM");
      const deadline = Date.now() + this.shutdownTimeoutMs;
      while (Date.now() < deadline && this.isProcessAlive(persisted.pid)) {
        await this.sleep(this.pollIntervalMs);
      }
      if (this.isProcessAlive(persisted.pid)) {
        this.signalProcess(persisted.pid, "SIGKILL");
      }
      await this.clearRuntimeState();
    });
  }

  async restart(): Promise<RuntimeStatus> {
    await this.stop();
    return this.ensureRunning();
  }

  async getStatus(): Promise<RuntimeStatus> {
    await prepareGatewayDirectories(this.paths);
    const persisted = await this.readPersistedState();
    const checkedAt = this.now().toISOString();
    if (!persisted) {
      return stoppedStatus(checkedAt, "Runtime is not running");
    }
    if (!this.isProcessAlive(persisted.pid)) {
      return {
        state: "stopped",
        pid: persisted.pid,
        baseUrl: persisted.baseUrl,
        startedAt: persisted.startedAt,
        checkedAt,
        reused: false,
        message: "Runtime state is stale because its process is not alive"
      };
    }
    const ready = await this.probeReady(persisted.baseUrl).catch(() => false);
    return {
      state: ready ? "ready" : "unhealthy",
      pid: persisted.pid,
      baseUrl: persisted.baseUrl,
      startedAt: persisted.startedAt,
      checkedAt,
      reused: false,
      message: ready ? "Runtime is ready" : "Runtime process is alive but its local API is unavailable"
    };
  }

  async doctor(): Promise<RuntimeDiagnostic[]> {
    await prepareGatewayDirectories(this.paths);
    const diagnostics: RuntimeDiagnostic[] = [];
    diagnostics.push(await writableDirectoryDiagnostic(this.paths.root));
    const status = await this.getStatus();
    if (status.state === "ready") {
      diagnostics.push({ code: "RUNTIME_READY", status: "ok", message: status.message });
    } else if (status.state === "stopped") {
      diagnostics.push({
        code: "RUNTIME_STOPPED",
        status: "warning",
        message: status.message,
        suggestedAction: "Run `omniagent-gateway start` or invoke the MCP server"
      });
    } else {
      diagnostics.push({
        code: "RUNTIME_UNHEALTHY",
        status: "error",
        message: status.message,
        suggestedAction: "Run `omniagent-gateway restart`, then inspect the runtime log"
      });
    }
    diagnostics.push({
      code: "RUNTIME_LOG",
      status: "ok",
      message: `Runtime log: ${this.paths.logPath}`
    });
    return diagnostics;
  }

  private async ensureRunningNow(): Promise<RuntimeStatus> {
    await prepareGatewayDirectories(this.paths);
    const existing = await this.getStatus();
    if (existing.state === "ready") return { ...existing, reused: true };

    return this.withLock(async () => {
      await migrateLegacyGatewayData(this.paths);
      const doubleChecked = await this.getStatus();
      if (doubleChecked.state === "ready") return { ...doubleChecked, reused: true };
      if (doubleChecked.pid && this.isProcessAlive(doubleChecked.pid)) {
        throw new Error(
          `OmniAgent Gateway Runtime process ${doubleChecked.pid} is alive but unhealthy; run restart explicitly`
        );
      }
      await this.clearRuntimeState();
      return this.spawnAndWait();
    });
  }

  private async spawnAndWait(): Promise<RuntimeStatus> {
    const baseUrl = await this.resolveBaseUrl();
    await mkdir(path.dirname(this.paths.logPath), { recursive: true, mode: 0o700 });
    const logFd = openSync(this.paths.logPath, "a", 0o600);
    let child: Pick<ChildProcess, "pid" | "unref">;
    try {
      child = this.spawnRuntime(this.nodeExecutable, [this.runtimeEntrypoint], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: {
          ...this.env,
          OMNIAGENT_GATEWAY_HOME: this.paths.root
        }
      });
    } finally {
      closeSync(logFd);
    }
    if (!child.pid) throw new Error("Runtime process did not expose a PID");
    child.unref();
    const startedAt = this.now().toISOString();
    const persisted: PersistedRuntimeState = {
      version: 1,
      pid: child.pid,
      baseUrl,
      startedAt
    };
    await this.writePersistedState(persisted);
    await atomicWrite(this.paths.pidPath, `${child.pid}\n`);

    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (!this.isProcessAlive(child.pid)) {
        await this.clearRuntimeState();
        throw new Error(`OmniAgent Gateway Runtime exited during startup; inspect ${this.paths.logPath}`);
      }
      if (await this.probeReady(baseUrl).catch(() => false)) {
        return {
          state: "ready",
          pid: child.pid,
          baseUrl,
          startedAt,
          checkedAt: this.now().toISOString(),
          reused: false,
          message: "Runtime started and is ready"
        };
      }
      await this.sleep(this.pollIntervalMs);
    }
    if (this.isProcessAlive(child.pid)) {
      this.signalProcess(child.pid, "SIGTERM");
    }
    await this.clearRuntimeState();
    throw new Error(`Runtime did not become ready within ${this.startupTimeoutMs} ms; inspect ${this.paths.logPath}`);
  }

  private async resolveBaseUrl(): Promise<string> {
    try {
      const parsed = JSON.parse(await readFile(this.paths.configPath, "utf8")) as {
        runtime?: { listenHost?: unknown; listenPort?: unknown };
        value?: { runtime?: { listenHost?: unknown; listenPort?: unknown } };
      };
      const runtime = parsed.runtime ?? parsed.value?.runtime;
      const host = typeof runtime?.listenHost === "string" ? runtime.listenHost : "127.0.0.1";
      const port = typeof runtime?.listenPort === "number" ? runtime.listenPort : 3100;
      return `http://${normalizeLoopbackHost(host)}:${port}`;
    } catch {
      return "http://127.0.0.1:3100";
    }
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      let handle;
      try {
        handle = await open(this.paths.runtimeLockPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: this.now().toISOString() }));
        await handle.sync();
        try {
          return await work();
        } finally {
          await handle.close();
          await unlink(this.paths.runtimeLockPath).catch(() => undefined);
        }
      } catch (error) {
        await handle?.close().catch(() => undefined);
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        if (await this.removeStaleLock()) continue;
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for Runtime lock ${this.paths.runtimeLockPath}`);
        }
        await this.sleep(this.pollIntervalMs);
      }
    }
  }

  private async removeStaleLock(): Promise<boolean> {
    try {
      const info = await stat(this.paths.runtimeLockPath);
      if (Date.now() - info.mtimeMs < this.staleLockMs) return false;
      let ownerPid: number | null = null;
      try {
        const raw = JSON.parse(await readFile(this.paths.runtimeLockPath, "utf8")) as { pid?: unknown };
        ownerPid = typeof raw.pid === "number" ? raw.pid : null;
      } catch {
        // A stale, malformed lock cannot identify a live owner and is safe to remove.
      }
      if (ownerPid !== null && this.isProcessAlive(ownerPid)) return false;
      await unlink(this.paths.runtimeLockPath);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }

  private async readPersistedState(): Promise<PersistedRuntimeState | null> {
    try {
      const parsed = JSON.parse(await readFile(this.paths.runtimeStatePath, "utf8")) as Partial<PersistedRuntimeState>;
      if (parsed.version !== 1
        || !Number.isSafeInteger(parsed.pid)
        || (parsed.pid ?? 0) <= 0
        || typeof parsed.baseUrl !== "string"
        || typeof parsed.startedAt !== "string") {
        return null;
      }
      return parsed as PersistedRuntimeState;
    } catch {
      return null;
    }
  }

  private writePersistedState(state: PersistedRuntimeState): Promise<void> {
    return atomicWrite(this.paths.runtimeStatePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  private async clearRuntimeState(): Promise<void> {
    await Promise.all([
      unlink(this.paths.runtimeStatePath).catch(() => undefined),
      unlink(this.paths.pidPath).catch(() => undefined)
    ]);
  }
}

async function probeRuntimeReady(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  timeout.unref?.();
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/v1/session`, {
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    return response.ok;
  } finally {
    clearTimeout(timeout);
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function atomicWrite(destination: string, content: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const handle = await open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function writableDirectoryDiagnostic(root: string): Promise<RuntimeDiagnostic> {
  const probe = path.join(root, `.write-probe-${process.pid}-${Date.now()}`);
  try {
    await writeFile(probe, "ok", { flag: "wx", mode: 0o600 });
    await access(probe);
    return { code: "DATA_DIRECTORY_WRITABLE", status: "ok", message: `Data directory is writable: ${root}` };
  } catch (error) {
    return {
      code: "DATA_DIRECTORY_UNWRITABLE",
      status: "error",
      message: `Data directory is not writable: ${errorMessage(error)}`,
      suggestedAction: `Check ownership and permissions for ${root}`
    };
  } finally {
    await unlink(probe).catch(() => undefined);
  }
}

function normalizeLoopbackHost(host: string): string {
  if (host === "::1") return "[::1]";
  return host === "localhost" || host.startsWith("127.") || host === "[::1]" ? host : "127.0.0.1";
}

function stoppedStatus(checkedAt: string, message: string): RuntimeStatus {
  return {
    state: "stopped",
    pid: null,
    baseUrl: null,
    startedAt: null,
    checkedAt,
    reused: false,
    message
  };
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
