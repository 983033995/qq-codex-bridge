import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BindConversationSpace } from "../../../packages/application/src/index.js";
import {
  AtomicConfigStore,
  calculateConfigRevision,
  createDefaultConfig,
  MacOsKeychainSecretStore
} from "../../../packages/config/src/index.js";
import { CodexAppServerAdapter } from "../../../packages/codex-appserver/src/index.js";
import { WeixinWorkerSupervisor } from "../../../packages/channel-weixin/src/index.js";
import { StructuredEventBus } from "../../../packages/observability/src/index.js";
import {
  openVNextDatabase,
  SqliteConversationSpaceRepository,
  SqliteMessageLedger,
  SqlitePushRepository,
  SqliteRoutingDecisionRepository,
  SqliteRuntimeEventRepository,
  SqliteThreadBindingRepository,
  SqliteTurnRepository
} from "../../../packages/store-sqlite/src/index.js";
import { ControlApiApplicationServices } from "./application-services.js";
import {
  ControlDaemonCompositionRoot,
  installGracefulShutdown,
  type ControlDaemonComponent
} from "./composition-root.js";
import { ControlApiServer, type ControlApiServices } from "./control-api.js";

export type ProductionControlDaemon = {
  daemon: ControlDaemonCompositionRoot;
  api: ControlApiServer;
  baseUrl: string;
  start(): Promise<void>;
  stop(): Promise<void>;
};

export async function createProductionControlDaemon(options: {
  dataDirectory?: string;
  staticRoot?: string;
  appServerUrl?: string;
  weixinWorkerScriptPath?: string;
  weixinWorkerExecArgv?: string[];
  weixinLoginBaseUrl?: string;
  weixinLoginBotType?: string;
  weixinQrFetchTimeoutMs?: number;
  weixinQrPollTimeoutMs?: number;
  weixinQrTotalTimeoutMs?: number;
} = {}): Promise<ProductionControlDaemon> {
  const dataDirectory = options.dataDirectory ?? path.join(os.homedir(), ".qq-codex-bridge");
  const configStore = new AtomicConfigStore(path.join(dataDirectory, "config.json"));
  let configSnapshot = await configStore.read();
  if (!configSnapshot) {
    const config = createDefaultConfig();
    configSnapshot = { value: config, revision: calculateConfigRevision(config) };
    await configStore.writeAtomic(configSnapshot);
  }

  const database = openVNextDatabase(path.join(dataDirectory, "runtime-vnext.db"));
  const spaces = new SqliteConversationSpaceRepository(database);
  const bindings = new SqliteThreadBindingRepository(database);
  const messages = new SqliteMessageLedger(database);
  const turns = new SqliteTurnRepository(database);
  const decisions = new SqliteRoutingDecisionRepository(database);
  const runtimeEvents = new SqliteRuntimeEventRepository(database);
  const push = new SqlitePushRepository(database);
  const codex = new CodexAppServerAdapter({ appServerUrl: options.appServerUrl });
  const secretStore = new MacOsKeychainSecretStore();
  const staticRoot = options.staticRoot ?? path.join(process.cwd(), "dist", "apps", "control-ui");
  const eventBus = new StructuredEventBus();
  const weixinWorker = new WeixinWorkerSupervisor({
    workerScriptPath: options.weixinWorkerScriptPath
      ?? fileURLToPath(new URL("../../weixin-worker/src/cli.js", import.meta.url)),
    ...(options.weixinWorkerExecArgv ? { execArgv: options.weixinWorkerExecArgv } : {}),
    async configuration() {
      const snapshot = await configStore.read();
      if (!snapshot) throw new Error("Config is unavailable for the Weixin worker");
      return {
        accounts: snapshot.value.channels
          .filter((channel) => channel.channel === "weixin" && channel.enabled)
          .map((channel) => `weixin:${channel.accountId}`),
        login: {
          stateFilePath: path.join(dataDirectory, "weixin-login-state.json"),
          baseUrl: options.weixinLoginBaseUrl ?? "https://ilinkai.weixin.qq.com",
          botType: options.weixinLoginBotType ?? "3",
          qrFetchTimeoutMs: options.weixinQrFetchTimeoutMs ?? 10_000,
          qrPollTimeoutMs: options.weixinQrPollTimeoutMs ?? 35_000,
          qrTotalTimeoutMs: options.weixinQrTotalTimeoutMs ?? 8 * 60_000
        }
      };
    },
    onEvent(event) {
      eventBus.publish({ component: "weixin-worker", type: event.type, payload: event.payload });
    }
  });

  let services: ControlApiServices | null = null;
  const api = new ControlApiServer({
    host: configSnapshot.value.runtime.listenHost,
    port: configSnapshot.value.runtime.listenPort,
    services: {
      execute(invocation) {
        if (!services) {
          throw new Error("Control API services are not initialized");
        }
        return services.execute(invocation);
      }
    },
    events: eventBus,
    ...(existsSync(path.join(staticRoot, "index.html")) ? { staticRoot } : {})
  });
  const daemon = new ControlDaemonCompositionRoot({
    components: [
      codexComponent(codex),
      weixinWorker,
      passiveComponent("router", false, "Router is disabled until configured"),
      passiveComponent("push", false, "Push worker is disabled until configured"),
      passiveComponent("queues", true, "Thread queues are ready"),
      api
    ],
    events: eventBus
  });

  const bindConversationSpace = new BindConversationSpace({
    spaces,
    bindings,
    codex,
    ids: { next: randomUUID },
    clock: { now: () => new Date() }
  });
  services = new ControlApiApplicationServices({
    daemon,
    configStore,
    secretStore,
    codex,
    spaces,
    bindings,
    messages,
    turns,
    listTurns: (input) => turns.list(input),
    decisions,
    runtimeEvents,
    push,
    bindConversationSpace,
    channels: {
      async health(channelId) {
        requireWeixinChannel(channelId);
        const health = await weixinWorker.health();
        return {
          status: health.status,
          message: health.message,
          lastActivityAt: health.lastSuccessAt ?? null
        };
      },
      async test(channelId) {
        requireWeixinChannel(channelId);
        await weixinWorker.ping();
        return { ok: true, message: "Weixin worker IPC round-trip succeeded" };
      },
      async restart(channelId) {
        requireWeixinChannel(channelId);
        await weixinWorker.restart();
        return { restarted: true };
      },
      async loginStatus(channelId) {
        requireWeixinChannel(channelId);
        return weixinWorker.loginStatus(channelId);
      },
      async startLogin(channelId, force) {
        requireWeixinChannel(channelId);
        return weixinWorker.startLogin(channelId, force);
      },
      async logout(channelId) {
        requireWeixinChannel(channelId);
        return weixinWorker.logout(channelId);
      }
    },
    exportDiagnostics: (includeLogs) => exportDiagnostics({
      dataDirectory,
      includeLogs,
      configStore,
      runtimeEvents
    }),
    version: "0.2.0"
  });

  const unsubscribe = daemon.events.subscribe((event) => {
    void runtimeEvents.append({
      eventId: event.eventId,
      component: event.component,
      type: event.type,
      payloadJson: JSON.stringify(event.payload),
      createdAt: event.occurredAt
    }).catch((error) => {
      process.stderr.write(`[qq-codex-bridge-vnext] failed to persist runtime event: ${errorMessage(error)}\n`);
    });
  });
  let stopped = false;

  return {
    daemon,
    api,
    baseUrl: `http://${configSnapshot.value.runtime.listenHost}:${configSnapshot.value.runtime.listenPort}`,
    async start() {
      await daemon.start();
      await daemon.applyPlan({ revision: configSnapshot!.revision, effects: [] });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      try {
        await daemon.stop();
      } finally {
        database.close();
      }
    }
  };
}

export async function runProductionControlDaemon(): Promise<ProductionControlDaemon> {
  const runtime = await createProductionControlDaemon();
  const removeSignalHandlers = installGracefulShutdown({
    async stop() {
      removeSignalHandlers();
      await runtime.stop();
    }
  });
  await runtime.start();
  process.stdout.write(`[qq-codex-bridge-vnext] management UI ready at ${runtime.baseUrl}\n`);
  return runtime;
}

function codexComponent(codex: CodexAppServerAdapter): ControlDaemonComponent {
  return {
    name: "codex",
    critical: true,
    start() {},
    stop: () => codex.dispose(),
    async health() {
      const health = await codex.health();
      return { ...health, component: "codex" };
    }
  };
}

function passiveComponent(name: string, critical: boolean, message: string): ControlDaemonComponent {
  const since = new Date().toISOString();
  return {
    name,
    critical,
    start() {},
    stop() {},
    reload() {},
    async health() {
      return { component: name, status: "ready", message, since };
    }
  };
}

async function exportDiagnostics(input: {
  dataDirectory: string;
  includeLogs: boolean;
  configStore: AtomicConfigStore;
  runtimeEvents: SqliteRuntimeEventRepository;
}): Promise<{ path: string; createdAt: string }> {
  const createdAt = new Date().toISOString();
  const directory = path.join(input.dataDirectory, "diagnostics");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filePath = path.join(directory, `diagnostics-${createdAt.replace(/[:.]/g, "-")}.json`);
  const events = await input.runtimeEvents.list({ limit: input.includeLogs ? 200 : 25 });
  const config = await input.configStore.read();
  await writeFile(filePath, `${JSON.stringify({ createdAt, config: config?.value ?? null, events }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  return { path: filePath, createdAt };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireWeixinChannel(channelId: string): void {
  if (!channelId.startsWith("weixin:") || channelId.length <= "weixin:".length) {
    throw new Error(`Channel runtime '${channelId}' is not connected`);
  }
}
