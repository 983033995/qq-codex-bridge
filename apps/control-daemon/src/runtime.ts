import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BindConversationSpace,
  EnqueuePush,
  ExecuteControlAction,
  ReceiveInboundMessage,
  RouteInboundMessage,
  ReconcileRecoverableTurns,
  StartConversationTurn,
  ThreadScheduler,
  ConversationResolver
} from "../../../packages/application/src/index.js";
import {
  ApprovalService,
  type ApprovalRequest
} from "../../../packages/approval/src/index.js";
import {
  AtomicConfigStore,
  calculateConfigRevision,
  createDefaultConfig,
  MacOsKeychainSecretStore
} from "../../../packages/config/src/index.js";
import { CodexAppServerAdapter } from "../../../packages/codex-appserver/src/index.js";
import { WeixinWorkerSupervisor } from "../../../packages/channel-weixin/src/index.js";
import { StructuredEventBus } from "../../../packages/observability/src/index.js";
import { OpenAiCompatibleIntentRouter } from "../../../packages/router-openai-compatible/src/index.js";
import {
  migrateLegacyGatewayData,
  resolveGatewayPaths
} from "../../../packages/runtime-manager/src/index.js";
import {
  openVNextDatabase,
  schemaMigrations,
  migrateSourceRoutingData,
  SqliteConversationSpaceRepository,
  SqliteApprovalRepository,
  SqliteActiveConversationRepository,
  SqliteChannelMessageRegistryRepository,
  SqliteConversationAliasRepository,
  SqliteDeliveryRepository,
  SqliteMessageLedger,
  SqlitePushRepository,
  SqliteRoutingDecisionRepository,
  SqliteRuntimeEventRepository,
  SqliteSetupRepository,
  SqliteThreadBindingRepository,
  SqliteTurnRepository
} from "../../../packages/store-sqlite/src/index.js";
import { SetupService } from "../../../packages/setup/src/index.js";
import { ControlApiApplicationServices } from "./application-services.js";
import {
  ControlDaemonCompositionRoot,
  installGracefulShutdown,
  type ControlDaemonComponent
} from "./composition-root.js";
import { ControlApiServer, type ControlApiServices } from "./control-api.js";
import { WeixinMessageRuntime } from "./weixin-message-runtime.js";
import { FeishuAccountRuntime } from "./feishu-account-runtime.js";
import { QqAccountRuntime } from "./qq-account-runtime.js";

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
  const productionPaths = resolveGatewayPaths({
    root: process.env.OMNIAGENT_GATEWAY_HOME ?? path.join(os.homedir(), ".omniagent-gateway")
  });
  if (!options.dataDirectory) {
    await migrateLegacyGatewayData(productionPaths);
  }
  const dataDirectory = options.dataDirectory ?? productionPaths.dataDirectory;
  const configPath = options.dataDirectory
    ? path.join(dataDirectory, "config.json")
    : productionPaths.configPath;
  const databasePath = options.dataDirectory
    ? path.join(dataDirectory, "runtime-vnext.db")
    : productionPaths.databasePath;
  const configStore = new AtomicConfigStore(configPath);
  let configSnapshot = await configStore.read();
  if (!configSnapshot) {
    const config = createDefaultConfig();
    configSnapshot = { value: config, revision: calculateConfigRevision(config) };
    await configStore.writeAtomic(configSnapshot);
  }

  const database = openVNextDatabase(databasePath);
  const sourceRoutingDatabase = openVNextDatabase(
    options.dataDirectory
      ? path.join(dataDirectory, "source-routing.sqlite")
      : productionPaths.sourceRoutingDatabasePath,
    { migrations: schemaMigrations.filter((migration) => migration.version === 7) }
  );
  migrateSourceRoutingData(database, sourceRoutingDatabase);
  const spaces = new SqliteConversationSpaceRepository(database);
  const bindings = new SqliteThreadBindingRepository(database);
  const messages = new SqliteMessageLedger(database);
  const deliveries = new SqliteDeliveryRepository(database);
  const turns = new SqliteTurnRepository(database);
  const decisions = new SqliteRoutingDecisionRepository(database);
  const runtimeEvents = new SqliteRuntimeEventRepository(database);
  const setupRepository = new SqliteSetupRepository(database);
  const approvalRepository = new SqliteApprovalRepository(database);
  const push = new SqlitePushRepository(database);
  const conversationAliases = new SqliteConversationAliasRepository(sourceRoutingDatabase);
  const channelMessageRegistry = new SqliteChannelMessageRegistryRepository(sourceRoutingDatabase);
  const activeConversations = new SqliteActiveConversationRepository(sourceRoutingDatabase);
  const conversationResolver = new ConversationResolver({
    aliases: conversationAliases,
    registry: channelMessageRegistry,
    active: activeConversations
  });
  let approvals!: ApprovalService;
  const codex = new CodexAppServerAdapter({
    appServerUrl: options.appServerUrl,
    async onApprovalRequest(request) {
      await approvals.capture(request);
    },
    async onServerRequestResolved(input) {
      await approvals.markServerResolved(input);
    }
  });
  const secretStore = new MacOsKeychainSecretStore();
  const router = new OpenAiCompatibleIntentRouter({ configStore, secretStore });
  const staticRoot = options.staticRoot ?? path.join(process.cwd(), "dist", "apps", "control-ui");
  const eventBus = new StructuredEventBus();
  let weixinMessages: WeixinMessageRuntime | null = null;
  let feishuMessages: WeixinMessageRuntime | null = null;
  let qqMessages: WeixinMessageRuntime | null = null;
  approvals = new ApprovalService({
    repository: approvalRepository,
    bridge: {
      respond: (input) => codex.resolveApprovalRequest({
        requestId: input.requestId,
        resolution: input.resolution
      })
    },
    nextId: randomUUID,
    onCaptured: (request) => notifyApprovalBindings(request, "pending"),
    onResolved: (request) => notifyApprovalBindings(request, "resolved")
  });

  async function notifyApprovalBindings(
    request: ApprovalRequest,
    phase: "pending" | "resolved"
  ): Promise<void> {
    const activeBindings = await bindings.listActiveByThread(request.threadId);
    const results = await Promise.allSettled(activeBindings.map(async (binding) => {
      const space = await spaces.get(binding.spaceId);
      if (!space) return;
      const runtime = space.channel === "weixin"
        ? weixinMessages
        : space.channel === "feishu"
          ? feishuMessages
          : qqMessages;
      if (!runtime) throw new Error(`${space.channel} message runtime is not initialized`);
      await runtime.deliverNotice({
        spaceId: space.spaceId,
        deliveryKey: `approval:${request.approvalId}:${phase}:${space.spaceId}`,
        text: formatApprovalNotice(request, phase),
        source: await conversationResolver.sourceForBinding(binding)
      });
    }));
    results.forEach((result, index) => {
      if (result.status === "fulfilled") return;
      eventBus.publish({
        component: "approval",
        type: "approval.notice.delivery_failed",
        payload: {
          approvalId: request.approvalId,
          spaceId: activeBindings[index]?.spaceId ?? null,
          error: errorMessage(result.reason)
        }
      });
    });
  }
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
        },
        message: {
          stateFilePath: path.join(dataDirectory, "weixin-message-state.json"),
          longPollTimeoutMs: 35_000,
          apiTimeoutMs: 15_000,
          retryDelayMs: 2_000
        }
      };
    },
    onEvent(event) {
      eventBus.publish({ component: "weixin-worker", type: event.type, payload: event.payload });
    },
    onInboundMessage(message) {
      if (!weixinMessages) throw new Error("Weixin message runtime is not initialized");
      return weixinMessages.accept(message);
    }
  });
  const feishuAccounts = new Map(configSnapshot.value.channels
    .flatMap((channel) => channel.channel === "feishu" && channel.enabled ? [channel] : [])
    .map((channel) => {
      const id = `feishu:${channel.accountId}`;
      const runtime = new FeishuAccountRuntime({
        accountId: channel.accountId,
        appId: channel.appId,
        secretRef: channel.secretRef,
        secrets: secretStore,
        async onInbound(message) {
          if (!feishuMessages) throw new Error("Feishu message runtime is not initialized");
          await feishuMessages.accept(message);
        },
        onError(error) {
          eventBus.publish({
            component: id,
            type: "feishu.runtime.error",
            payload: { error: error.message }
          });
        },
        onIgnoredMessage(diagnostic) {
          eventBus.publish({
            component: id,
            type: "feishu.message.ignored",
            payload: diagnostic
          });
        }
      });
      return [id, runtime] as const;
    }));
  const qqAccounts = new Map(configSnapshot.value.channels
    .flatMap((channel) => channel.channel === "qq" && channel.enabled ? [channel] : [])
    .map((channel) => {
      const id = `qq:${channel.accountId}`;
      const runtime = new QqAccountRuntime({
        accountId: channel.accountId,
        appId: channel.appId,
        secretRef: channel.secretRef,
        dataDirectory,
        secrets: secretStore,
        async onInbound(message) {
          if (!qqMessages) throw new Error("QQ message runtime is not initialized");
          await qqMessages.accept(message);
        },
        onError(error) {
          eventBus.publish({
            component: id,
            type: "qq.runtime.error",
            payload: { error: error.message }
          });
        }
      });
      return [id, runtime] as const;
    }));

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
      ...feishuAccounts.values(),
      ...qqAccounts.values(),
      routerComponent(router),
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
    clock: { now: () => new Date() },
    conversationResolver
  });
  const receiveInboundMessage = new ReceiveInboundMessage({ spaces, messages });
  const scheduler = new ThreadScheduler({
    events: runtimeEvents,
    ids: { next: randomUUID },
    clock: { now: () => new Date() }
  });
  const startConversationTurn = new StartConversationTurn({
    bindings,
    turns,
    codex,
    ids: { next: randomUUID },
    clock: { now: () => new Date() },
    scheduler
  });
  const reconcileRecoverableTurns = new ReconcileRecoverableTurns({
    turns,
    codex,
    events: runtimeEvents,
    ids: { next: randomUUID },
    clock: { now: () => new Date() }
  });
  const executeControlAction = new ExecuteControlAction({
    codex,
    bindings,
    turns,
    pushes: push,
    bindConversationSpace,
    enqueuePush: new EnqueuePush({
      pushes: push,
      ids: { next: randomUUID },
      clock: { now: () => new Date() }
    }),
    runHealthCheck: { execute: () => daemon.health.check() },
    clock: { now: () => new Date() },
    scheduler,
    threadListLimit: 20
  });
  const routeInboundMessage = new RouteInboundMessage({
    router,
    decisions,
    bindings,
    codex,
    controlActions: executeControlAction,
    conversationResolver,
    systemActions: {
      async restartChannel(input) {
        const channelId = await resolveSingleChannelId(configStore, input.channel, input.accountId);
        return controlServices.execute({
          operation: "channels.restart",
          params: { id: channelId },
          query: {},
          body: {}
        });
      },
      async startSetup(input) {
        const accountId = input.accountId
          ?? await resolveSetupAccountId(configStore, input.channel);
        return setup.start({ channel: input.channel, accountId, force: input.force });
      },
      async resolveApproval(input) {
        const binding = await bindings.getActiveBySpace(input.spaceId);
        if (!binding) throw new Error("当前会话尚未绑定 Codex Thread，无法定位待审批请求");
        return approvals.resolve({
          resolution: input.resolution,
          threadId: binding.threadId
        });
      }
    },
    ids: { next: randomUUID },
    clock: { now: () => new Date() },
    onRoutingError(error, message) {
      eventBus.publish({
        component: "intent-router",
        type: "router.inbound.degraded",
        payload: {
          providerMessageId: message.providerMessageId,
          spaceId: message.spaceId,
          error: error.message
        }
      });
    }
  });
  weixinMessages = new WeixinMessageRuntime({
    spaces,
    messages,
    turns,
    deliveries,
    receive: receiveInboundMessage,
    bind: bindConversationSpace,
    startTurn: startConversationTurn,
    route: routeInboundMessage,
    conversationResolver,
    worker: weixinWorker,
    ids: { next: randomUUID },
    clock: { now: () => new Date() },
    progress: { heartbeatIntervalMs: 60_000, maxUpdates: 60 },
    onProcessingError(error, message) {
      eventBus.publish({
        component: "weixin-message-runtime",
        type: "weixin.message.processing_failed",
        payload: {
          providerMessageId: message.providerMessageId,
          spaceId: message.spaceId,
          error: error.message
        }
      });
    },
    onProgressError(error, message) {
      eventBus.publish({
        component: "weixin-message-runtime",
        type: "weixin.message.progress_failed",
        payload: {
          providerMessageId: message.providerMessageId,
          spaceId: message.spaceId,
          error: error.message
        }
      });
    }
  });
  feishuMessages = new WeixinMessageRuntime({
    channel: "feishu",
    spaces,
    messages,
    turns,
    deliveries,
    receive: receiveInboundMessage,
    bind: bindConversationSpace,
    startTurn: startConversationTurn,
    route: routeInboundMessage,
    conversationResolver,
    worker: {
      async deliver(input) {
        const account = feishuAccounts.get(input.accountId);
        if (!account) throw new Error(`Feishu runtime '${input.accountId}' is not configured`);
        return account.deliver(input);
      }
    },
    ids: { next: randomUUID },
    clock: { now: () => new Date() },
    progress: { heartbeatIntervalMs: 60_000, maxUpdates: 60 },
    onProcessingError(error, message) {
      eventBus.publish({
        component: "feishu-message-runtime",
        type: "feishu.message.processing_failed",
        payload: {
          providerMessageId: message.providerMessageId,
          spaceId: message.spaceId,
          error: error.message
        }
      });
    },
    onProgressError(error, message) {
      eventBus.publish({
        component: "feishu-message-runtime",
        type: "feishu.message.progress_failed",
        payload: {
          providerMessageId: message.providerMessageId,
          spaceId: message.spaceId,
          error: error.message
        }
      });
    }
  });
  qqMessages = new WeixinMessageRuntime({
    channel: "qq",
    spaces,
    messages,
    turns,
    deliveries,
    receive: receiveInboundMessage,
    bind: bindConversationSpace,
    startTurn: startConversationTurn,
    route: routeInboundMessage,
    conversationResolver,
    worker: {
      async deliver(input) {
        const account = qqAccounts.get(input.accountId);
        if (!account) throw new Error(`QQ runtime '${input.accountId}' is not configured`);
        return account.deliver(input);
      }
    },
    ids: { next: randomUUID },
    clock: { now: () => new Date() },
    progress: { heartbeatIntervalMs: 60_000, maxUpdates: 60 },
    onProcessingError(error, message) {
      eventBus.publish({
        component: "qq-message-runtime",
        type: "qq.message.processing_failed",
        payload: {
          providerMessageId: message.providerMessageId,
          spaceId: message.spaceId,
          error: error.message
        }
      });
    },
    onProgressError(error, message) {
      eventBus.publish({
        component: "qq-message-runtime",
        type: "qq.message.progress_failed",
        payload: {
          providerMessageId: message.providerMessageId,
          spaceId: message.spaceId,
          error: error.message
        }
      });
    }
  });
  let controlServices!: ControlApiApplicationServices;
  const setup = new SetupService({
    repository: setupRepository,
    nextId: randomUUID,
    channels: {
      health: (channelId) => controlServices.execute({
        operation: "channels.list", params: {}, query: {}, body: {}
      }).then((items) => {
        const channel = (items as Array<{ id: string; status: string; message: string }>).find((item) => item.id === channelId);
        return channel ? { status: channel.status, message: channel.message } : { status: "offline", message: "渠道尚未加载" };
      }),
      test: (channelId) => controlServices.execute({
        operation: "channels.test", params: { id: channelId }, query: {}, body: {}
      }),
      loginStatus: (channelId) => controlServices.execute({
        operation: "channels.login.status", params: { id: channelId }, query: {}, body: {}
      }),
      startLogin: (channelId, force) => controlServices.execute({
        operation: "channels.login.start", params: { id: channelId }, query: {}, body: { force }
      }),
      logout: (channelId) => controlServices.execute({
        operation: "channels.login.logout", params: { id: channelId }, query: {}, body: {}
      })
    },
    configureChannel: (input) => controlServices.configureChannelForSetup(input)
  });
  controlServices = new ControlApiApplicationServices({
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
    router,
    setup,
    approvals,
    channels: {
      async health(channelId) {
        const qq = qqAccounts.get(channelId);
        if (qq) {
          const health = await qq.health();
          return {
            status: health.status,
            message: health.message,
            lastActivityAt: health.lastSuccessAt ?? null
          };
        }
        const feishu = feishuAccounts.get(channelId);
        if (feishu) {
          const health = await feishu.health();
          return {
            status: health.status,
            message: health.message,
            lastActivityAt: health.lastSuccessAt ?? null
          };
        }
        if (!isWeixinChannel(channelId)) {
          return {
            status: "degraded",
            message: "渠道配置已导入，但 vNext 运行时尚未连接",
            lastActivityAt: null
          };
        }
        const health = await weixinWorker.health();
        return {
          status: health.status,
          message: health.message,
          lastActivityAt: health.lastSuccessAt ?? null
        };
      },
      async test(channelId) {
        const qq = qqAccounts.get(channelId);
        if (qq) return qq.test();
        const feishu = feishuAccounts.get(channelId);
        if (feishu) return feishu.test();
        requireWeixinChannel(channelId);
        await weixinWorker.ping();
        return { ok: true, message: "Weixin worker IPC round-trip succeeded" };
      },
      async restart(channelId) {
        const qq = qqAccounts.get(channelId);
        if (qq) {
          await qq.restart();
          return { restarted: true };
        }
        const feishu = feishuAccounts.get(channelId);
        if (feishu) {
          await feishu.restart();
          return { restarted: true };
        }
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
    version: "0.3.0"
  });
  services = controlServices;

  const unsubscribe = daemon.events.subscribe((event) => {
    void runtimeEvents.append({
      eventId: event.eventId,
      component: event.component,
      type: event.type,
      payloadJson: JSON.stringify(event.payload),
      createdAt: event.occurredAt
    }).catch((error) => {
      process.stderr.write(`[OmniAgent Gateway] failed to persist runtime event: ${errorMessage(error)}\n`);
    });
  });
  let stopped = false;

  return {
    daemon,
    api,
    baseUrl: `http://${configSnapshot.value.runtime.listenHost}:${configSnapshot.value.runtime.listenPort}`,
    async start() {
      await hydrateLegacyConversationRouting({ spaces, bindings, conversationResolver });
      await reconcileRecoverableTurns.execute();
      await daemon.start();
      await weixinMessages!.start();
      await feishuMessages!.start();
      await qqMessages!.start();
      await daemon.applyPlan({ revision: configSnapshot!.revision, effects: [] });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      try {
        await weixinMessages!.stop();
        await feishuMessages!.stop();
        await qqMessages!.stop();
        await daemon.stop();
      } finally {
        sourceRoutingDatabase.close();
        database.close();
      }
    }
  };
}

async function hydrateLegacyConversationRouting(input: {
  spaces: SqliteConversationSpaceRepository;
  bindings: SqliteThreadBindingRepository;
  conversationResolver: ConversationResolver;
}): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await input.spaces.list({ limit: 200, ...(cursor ? { cursor } : {}) });
    for (const space of page.items) {
      const binding = await input.bindings.getActiveBySpace(space.spaceId);
      if (!binding) continue;
      await input.conversationResolver.ensureForBinding({ binding });
      if (!(await input.conversationResolver.getActiveConversation({ space }))) {
        await input.conversationResolver.ensureActiveForBinding({ space, binding });
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
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
  process.stdout.write(`[OmniAgent Gateway] management UI ready at ${runtime.baseUrl}\n`);
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

function routerComponent(router: OpenAiCompatibleIntentRouter): ControlDaemonComponent {
  return {
    name: "router",
    critical: false,
    start() {},
    stop() {},
    reload() {},
    health: () => router.health()
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

function formatApprovalNotice(request: ApprovalRequest, phase: "pending" | "resolved"): string {
  if (phase === "resolved") {
    const result = request.status === "approved"
      ? "已批准"
      : request.status === "declined"
        ? "已拒绝"
        : "已取消";
    return `【OmniAgent · Approval】\n审批 ${request.approvalId} ${result}`;
  }
  const subject = request.kind === "command_execution"
    ? `请求执行：${request.command ?? "命令"}`
    : `请求修改文件${request.grantRoot ? `：${request.grantRoot}` : ""}`;
  return [
    "【OmniAgent · Approval】",
    "Codex 等待你的确认",
    `审批 ID：${request.approvalId}`,
    subject,
    ...(request.reason ? [`原因：${request.reason}`] : []),
    "回复 /approve 或 /decline"
  ].join("\n");
}

async function resolveSingleChannelId(
  configStore: AtomicConfigStore,
  channel: "qq" | "weixin" | "feishu",
  accountId?: string
): Promise<string> {
  if (accountId) return `${channel}:${accountId}`;
  const config = await configStore.read();
  const matches = config?.value.channels.filter((candidate) => candidate.channel === channel) ?? [];
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `${channel} 渠道尚未配置`
      : `${channel} 有多个账户，请明确指定账户`);
  }
  return `${channel}:${matches[0]!.accountId}`;
}

async function resolveSetupAccountId(
  configStore: AtomicConfigStore,
  channel: "qq" | "weixin" | "feishu"
): Promise<string> {
  const config = await configStore.read();
  const matches = config?.value.channels.filter((candidate) => candidate.channel === channel) ?? [];
  if (matches.length > 1) throw new Error(`${channel} 有多个账户，请明确指定账户`);
  return matches[0]?.accountId ?? "default";
}

function requireWeixinChannel(channelId: string): void {
  if (!isWeixinChannel(channelId)) {
    throw new Error(`Channel runtime '${channelId}' is not connected`);
  }
}

function isWeixinChannel(channelId: string): boolean {
  return channelId.startsWith("weixin:") && channelId.length > "weixin:".length;
}
