import { timingSafeEqual, randomBytes, randomUUID } from "node:crypto";
import { fork, type ForkOptions } from "node:child_process";
import type { Readable } from "node:stream";
import type { ComponentHealth } from "../../domain/src/vnext/index.js";
import {
  WEIXIN_WORKER_AUTH_ENV,
  WEIXIN_WORKER_PROTOCOL_VERSION,
  parseWorkerToDaemonMessage,
  type DaemonToWorkerMessage,
  type WorkerToDaemonMessage
} from "./worker-protocol.js";

export type WeixinWorkerConfiguration = {
  accounts: string[];
};

export type WeixinWorkerEvent = {
  type: string;
  payload: Record<string, unknown>;
};

export type WeixinWorkerChild = {
  readonly pid?: number;
  readonly connected: boolean;
  readonly killed: boolean;
  readonly stdout?: Readable | null;
  readonly stderr?: Readable | null;
  send(message: DaemonToWorkerMessage, callback?: (error: Error | null) => void): boolean;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
};

export type WeixinWorkerSupervisorOptions = {
  workerScriptPath: string;
  configuration(): Promise<WeixinWorkerConfiguration> | WeixinWorkerConfiguration;
  daemonVersion?: string;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  pingTimeoutMs?: number;
  stopTimeoutMs?: number;
  stableUptimeMs?: number;
  restartBackoffMs?: readonly number[];
  execArgv?: string[];
  spawnWorker?(input: { scriptPath: string; env: NodeJS.ProcessEnv; execArgv?: string[] }): WeixinWorkerChild;
  onEvent?(event: WeixinWorkerEvent): void;
  now?: () => Date;
  randomToken?: () => string;
  randomId?: () => string;
};

type SupervisorState = "idle" | "disabled" | "starting" | "negotiating" | "ready" | "restarting" | "action_required" | "stopping" | "stopped";

export class WeixinWorkerSupervisor {
  readonly name = "weixin-worker";
  readonly critical = false;
  private readonly now: () => Date;
  private readonly randomToken: () => string;
  private readonly randomId: () => string;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly pingTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly stableUptimeMs: number;
  private readonly restartBackoffMs: readonly number[];
  private readonly spawnWorker: NonNullable<WeixinWorkerSupervisorOptions["spawnWorker"]>;
  private state: SupervisorState = "idle";
  private stateSince: string;
  private desiredRunning = false;
  private child: WeixinWorkerChild | null = null;
  private configuration: WeixinWorkerConfiguration = { accounts: [] };
  private authToken = "";
  private workerVersion: string | null = null;
  private lastHeartbeatAt: number | null = null;
  private lastHeartbeatSequence = -1;
  private lastSuccessAt: string | undefined;
  private lastError: string | null = null;
  private errorCode: string | undefined;
  private terminalFailure = false;
  private restartAttempt = 0;
  private transition: Promise<void> = Promise.resolve();
  private handshakeTimer: NodeJS.Timeout | null = null;
  private heartbeatMonitor: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private readonly pendingPings = new Map<string, { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }>();

  constructor(private readonly options: WeixinWorkerSupervisorOptions) {
    if (!options.workerScriptPath.trim()) throw new Error("workerScriptPath is required");
    this.now = options.now ?? (() => new Date());
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString("base64url"));
    this.randomId = options.randomId ?? randomUUID;
    this.heartbeatIntervalMs = positiveInteger(options.heartbeatIntervalMs ?? 5_000, "heartbeatIntervalMs");
    this.heartbeatTimeoutMs = positiveInteger(options.heartbeatTimeoutMs ?? 15_000, "heartbeatTimeoutMs");
    this.handshakeTimeoutMs = positiveInteger(options.handshakeTimeoutMs ?? 10_000, "handshakeTimeoutMs");
    this.pingTimeoutMs = positiveInteger(options.pingTimeoutMs ?? 2_000, "pingTimeoutMs");
    this.stopTimeoutMs = positiveInteger(options.stopTimeoutMs ?? 3_000, "stopTimeoutMs");
    this.stableUptimeMs = positiveInteger(options.stableUptimeMs ?? 60_000, "stableUptimeMs");
    if (this.heartbeatTimeoutMs <= this.heartbeatIntervalMs) {
      throw new Error("heartbeatTimeoutMs must be greater than heartbeatIntervalMs");
    }
    const restartBackoffMs = options.restartBackoffMs ?? [1_000, 5_000, 30_000];
    if (restartBackoffMs.length === 0 || restartBackoffMs.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new Error("restartBackoffMs must contain non-negative integers");
    }
    this.restartBackoffMs = [...restartBackoffMs];
    this.spawnWorker = options.spawnWorker ?? ((input) => fork(input.scriptPath, [], {
      env: input.env,
      execArgv: input.execArgv,
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    } satisfies ForkOptions) as unknown as WeixinWorkerChild);
    this.stateSince = this.now().toISOString();
  }

  start(): Promise<void> {
    return this.serialize(() => this.startNow());
  }

  stop(): Promise<void> {
    return this.serialize(() => this.stopNow());
  }

  restart(): Promise<void> {
    return this.serialize(async () => {
      await this.stopNow();
      await this.startNow();
    });
  }

  async ping(): Promise<void> {
    const child = this.child;
    if (!child || this.state !== "ready") {
      throw new Error("Weixin worker is not ready");
    }
    const id = this.randomId();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPings.delete(id);
        reject(new Error("Weixin worker ping timed out"));
      }, this.pingTimeoutMs);
      timer.unref();
      this.pendingPings.set(id, { resolve, reject, timer });
      try {
        this.send(child, { type: "ping", id, sentAt: this.now().toISOString() });
      } catch (error) {
        clearTimeout(timer);
        this.pendingPings.delete(id);
        reject(normalizeError(error));
      }
    });
  }

  async health(): Promise<ComponentHealth> {
    if (this.state === "disabled") {
      return { component: this.name, status: "ready", message: "Weixin worker is disabled until an account is enabled", since: this.stateSince };
    }
    if (this.state === "ready") {
      return {
        component: this.name,
        status: "ready",
        message: `Weixin worker IPC ready for ${this.configuration.accounts.length} account(s)`,
        since: this.stateSince,
        ...(this.lastSuccessAt ? { lastSuccessAt: this.lastSuccessAt } : {})
      };
    }
    if (this.state === "action_required") {
      return {
        component: this.name,
        status: "action_required",
        code: this.errorCode ?? "WEIXIN_WORKER_ACTION_REQUIRED",
        message: this.lastError ?? "Weixin worker requires attention",
        since: this.stateSince,
        suggestedAction: "Rebuild compatible Daemon and Weixin worker binaries"
      };
    }
    const stopped = this.state === "idle" || this.state === "stopped";
    return {
      component: this.name,
      status: stopped ? "offline" : "degraded",
      code: this.errorCode ?? (stopped ? "WEIXIN_WORKER_STOPPED" : "WEIXIN_WORKER_STARTING"),
      message: this.lastError ?? (stopped ? "Weixin worker is stopped" : `Weixin worker is ${this.state}`),
      since: this.stateSince,
      suggestedAction: stopped ? "Start the control daemon" : "Wait for the supervised worker restart"
    };
  }

  private async startNow(): Promise<void> {
    if (this.desiredRunning) return;
    this.desiredRunning = true;
    this.terminalFailure = false;
    this.restartAttempt = 0;
    try {
      this.configuration = normalizeConfiguration(await this.options.configuration());
    } catch (error) {
      this.setFailure("action_required", "WEIXIN_WORKER_CONFIG_INVALID", error);
      return;
    }
    if (this.configuration.accounts.length === 0) {
      this.setState("disabled");
      this.lastError = null;
      this.errorCode = undefined;
      return;
    }
    this.spawnCurrentWorker();
  }

  private async stopNow(): Promise<void> {
    this.desiredRunning = false;
    this.terminalFailure = false;
    this.clearTimers();
    this.rejectPendingPings(new Error("Weixin worker is stopping"));
    const child = this.child;
    if (!child) {
      this.setState("stopped");
      return;
    }
    this.setState("stopping");
    try {
      if (child.connected) {
        this.send(child, { type: "shutdown", reason: "Control daemon is stopping" });
      }
    } catch {
      child.kill("SIGTERM");
    }
    await this.waitForExit(child);
    if (this.child === child) this.child = null;
    this.setState("stopped");
  }

  private spawnCurrentWorker(): void {
    if (!this.desiredRunning || this.terminalFailure || this.child) return;
    this.setState(this.restartAttempt === 0 ? "starting" : "restarting");
    this.lastError = null;
    this.errorCode = undefined;
    this.authToken = required(this.randomToken(), "worker auth token");
    this.workerVersion = null;
    this.lastHeartbeatSequence = -1;
    try {
      const child = this.spawnWorker({
        scriptPath: this.options.workerScriptPath,
        env: workerEnvironment(this.authToken),
        ...(this.options.execArgv ? { execArgv: [...this.options.execArgv] } : {})
      });
      this.child = child;
      child.stdout?.resume();
      child.stderr?.resume();
      child.on("message", (message) => this.onMessage(child, message));
      child.on("error", (error) => this.onChildError(child, error));
      child.on("exit", (code, signal) => this.onChildExit(child, code, signal));
      this.publish("weixin.worker.spawned", { pid: child.pid ?? null, attempt: this.restartAttempt + 1 });
      this.handshakeTimer = setTimeout(() => {
        if (this.child !== child || this.state === "ready") return;
        this.lastError = "Weixin worker handshake timed out";
        this.errorCode = "WEIXIN_WORKER_HANDSHAKE_TIMEOUT";
        child.kill("SIGKILL");
      }, this.handshakeTimeoutMs);
      this.handshakeTimer.unref();
    } catch (error) {
      this.setFailure("restarting", "WEIXIN_WORKER_SPAWN_FAILED", error);
      this.scheduleRestart();
    }
  }

  private onMessage(child: WeixinWorkerChild, value: unknown): void {
    if (this.child !== child) return;
    let message: WorkerToDaemonMessage;
    try {
      message = parseWorkerToDaemonMessage(value);
    } catch (error) {
      this.rejectProtocol(child, "WEIXIN_WORKER_PROTOCOL_INVALID", error);
      return;
    }
    if (message.type === "hello") {
      if (this.state !== "starting" && this.state !== "restarting") {
        this.rejectProtocol(child, "WEIXIN_WORKER_PROTOCOL_INVALID", new Error("Unexpected worker hello"));
        return;
      }
      if (!secureEqual(message.authToken, this.authToken)) {
        this.rejectProtocol(child, "WEIXIN_WORKER_AUTH_FAILED", new Error("Weixin worker authentication failed"));
        return;
      }
      if (message.protocolVersion !== WEIXIN_WORKER_PROTOCOL_VERSION) {
        this.rejectProtocol(child, "WEIXIN_WORKER_PROTOCOL_MISMATCH", new Error(
          `Weixin worker protocol ${message.protocolVersion} is incompatible with ${WEIXIN_WORKER_PROTOCOL_VERSION}`
        ));
        return;
      }
      this.workerVersion = message.workerVersion;
      this.setState("negotiating");
      this.send(child, {
        type: "initialize",
        protocolVersion: WEIXIN_WORKER_PROTOCOL_VERSION,
        daemonVersion: this.options.daemonVersion ?? "0.2.0",
        heartbeatIntervalMs: this.heartbeatIntervalMs,
        accounts: [...this.configuration.accounts]
      });
      this.publish("weixin.worker.authenticated", { pid: message.pid, workerVersion: message.workerVersion });
      return;
    }
    if (message.type === "ready") {
      if (this.state !== "negotiating" || message.workerVersion !== this.workerVersion || !sameItems(message.accounts, this.configuration.accounts)) {
        this.rejectProtocol(child, "WEIXIN_WORKER_NEGOTIATION_FAILED", new Error("Weixin worker returned an inconsistent ready response"));
        return;
      }
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
      this.lastHeartbeatAt = this.now().getTime();
      this.lastSuccessAt = this.now().toISOString();
      this.setState("ready");
      this.startHeartbeatMonitor(child);
      this.stableTimer = setTimeout(() => { this.restartAttempt = 0; }, this.stableUptimeMs);
      this.stableTimer.unref();
      this.publish("weixin.worker.ready", { workerVersion: message.workerVersion, accounts: message.accounts });
      return;
    }
    if (message.type === "heartbeat") {
      if (this.state !== "ready" || message.sequence <= this.lastHeartbeatSequence) {
        this.rejectProtocol(child, "WEIXIN_WORKER_HEARTBEAT_INVALID", new Error("Weixin worker heartbeat is out of order"));
        return;
      }
      this.lastHeartbeatSequence = message.sequence;
      this.lastHeartbeatAt = this.now().getTime();
      this.lastSuccessAt = message.occurredAt;
      return;
    }
    if (message.type === "pong") {
      const pending = this.pendingPings.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingPings.delete(message.id);
        this.lastSuccessAt = message.occurredAt;
        pending.resolve();
      }
    }
  }

  private onChildError(child: WeixinWorkerChild, error: Error): void {
    if (this.child !== child) return;
    this.lastError = error.message;
    this.errorCode = "WEIXIN_WORKER_PROCESS_ERROR";
    child.kill("SIGKILL");
  }

  private onChildExit(child: WeixinWorkerChild, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = null;
    this.clearChildTimers();
    this.rejectPendingPings(new Error("Weixin worker exited"));
    this.publish("weixin.worker.exited", { code, signal, expected: !this.desiredRunning });
    if (!this.desiredRunning) return;
    if (this.terminalFailure) return;
    this.lastError = this.lastError ?? `Weixin worker exited (${signal ?? code ?? "unknown"})`;
    this.errorCode = this.errorCode ?? "WEIXIN_WORKER_EXITED";
    this.scheduleRestart();
  }

  private startHeartbeatMonitor(child: WeixinWorkerChild): void {
    if (this.heartbeatMonitor) clearInterval(this.heartbeatMonitor);
    const interval = Math.max(10, Math.floor(this.heartbeatTimeoutMs / 3));
    this.heartbeatMonitor = setInterval(() => {
      if (this.child !== child || this.state !== "ready" || this.lastHeartbeatAt === null) return;
      if (this.now().getTime() - this.lastHeartbeatAt <= this.heartbeatTimeoutMs) return;
      this.lastError = "Weixin worker heartbeat timed out";
      this.errorCode = "WEIXIN_WORKER_HEARTBEAT_TIMEOUT";
      this.publish("weixin.worker.heartbeat_timeout", { lastHeartbeatAt: this.lastSuccessAt ?? null });
      child.kill("SIGKILL");
    }, interval);
    this.heartbeatMonitor.unref();
  }

  private rejectProtocol(child: WeixinWorkerChild, code: string, error: unknown): void {
    this.terminalFailure = true;
    this.setFailure("action_required", code, error);
    this.publish("weixin.worker.rejected", { code, error: this.lastError });
    child.kill("SIGKILL");
  }

  private scheduleRestart(): void {
    if (!this.desiredRunning || this.terminalFailure || this.restartTimer) return;
    this.setState("restarting");
    const index = Math.min(this.restartAttempt, this.restartBackoffMs.length - 1);
    const delayMs = this.restartBackoffMs[index]!;
    this.restartAttempt += 1;
    this.publish("weixin.worker.restart_scheduled", { attempt: this.restartAttempt, delayMs });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnCurrentWorker();
    }, delayMs);
    this.restartTimer.unref();
  }

  private send(child: WeixinWorkerChild, message: DaemonToWorkerMessage): void {
    if (!child.connected) throw new Error("Weixin worker IPC channel is disconnected");
    child.send(message, (error) => {
      if (error && this.child === child) this.onChildError(child, error);
    });
  }

  private async waitForExit(child: WeixinWorkerChild): Promise<void> {
    await new Promise<void>((resolve) => {
      let complete = false;
      const done = () => {
        if (complete) return;
        complete = true;
        clearTimeout(timer);
        child.off("exit", onExit);
        resolve();
      };
      const onExit = () => done();
      child.once("exit", onExit);
      const timer = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
        done();
      }, this.stopTimeoutMs);
      timer.unref();
    });
  }

  private clearTimers(): void {
    this.clearChildTimers();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private clearChildTimers(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    if (this.heartbeatMonitor) clearInterval(this.heartbeatMonitor);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.handshakeTimer = null;
    this.heartbeatMonitor = null;
    this.stableTimer = null;
  }

  private rejectPendingPings(error: Error): void {
    for (const pending of this.pendingPings.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingPings.clear();
  }

  private setFailure(state: SupervisorState, code: string, error: unknown): void {
    this.lastError = normalizeError(error).message;
    this.errorCode = code;
    this.setState(state);
  }

  private setState(state: SupervisorState): void {
    if (this.state === state) return;
    this.state = state;
    this.stateSince = this.now().toISOString();
  }

  private publish(type: string, payload: Record<string, unknown>): void {
    this.options.onEvent?.({ type, payload: structuredClone(payload) });
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.transition.then(work, work);
    this.transition = result.then(() => undefined, () => undefined);
    return result;
  }
}

function normalizeConfiguration(value: WeixinWorkerConfiguration): WeixinWorkerConfiguration {
  if (!value || !Array.isArray(value.accounts)) throw new Error("Weixin worker accounts must be an array");
  const accounts = value.accounts.map((account) => required(account, "Weixin worker account"));
  if (accounts.length > 32) throw new Error("Weixin worker supports at most 32 accounts");
  if (new Set(accounts).size !== accounts.length) throw new Error("Weixin worker accounts must be unique");
  return { accounts: [...accounts].sort() };
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function sameItems(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function workerEnvironment(authToken: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { [WEIXIN_WORKER_AUTH_ENV]: authToken };
  for (const name of ["LANG", "LC_ALL", "TZ"] as const) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}
