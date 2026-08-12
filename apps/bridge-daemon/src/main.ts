import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { InboundMessage, OutboundDraft, TurnEvent } from "../../../packages/domain/src/message.js";
import { AdminRepository } from "../../../packages/store/src/admin-repo.js";
import { SqlitePushRepository } from "../../../packages/store/src/push-repo.js";
import { bootstrap, INTERNAL_TURN_EVENT_PATH } from "./bootstrap.js";
import { createAdminRoutes } from "./admin-routes.js";
import { createBridgeHttpServer } from "./http-server.js";
import { createPushApiRoutes } from "../../../packages/push/src/push-api-routes.js";
import { ThreadCommandHandler } from "./thread-command-handler.js";
import { startWeixinGatewayService, type WeixinGatewayServiceHandle } from "../../weixin-gateway/src/cli.js";

type IngressMessageHandlerDeps = {
  threadCommandHandler: Pick<ThreadCommandHandler, "handleIfCommand">;
  orchestrator: {
    handleInbound: (message: InboundMessage) => Promise<void>;
  };
  errorEgress?: {
    deliver(draft: OutboundDraft): Promise<unknown>;
  };
  runtimeEvents?: Pick<AdminRepository, "recordEvent">;
};

export function createIngressMessageHandler(deps: IngressMessageHandlerDeps) {
  return async (message: InboundMessage) => {
    try {
      const handled = await deps.threadCommandHandler.handleIfCommand(message);
      if (handled) {
        return;
      }
      await deps.orchestrator.handleInbound(message);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[qq-codex-bridge] message handling failed", {
        messageId: message.messageId,
        sessionKey: message.sessionKey,
        error: errorMessage
      });
      if (error instanceof Error && error.stack) {
        console.error("  stack:", error.stack);
      }
      try {
        await deps.runtimeEvents?.recordEvent({
          level: "error",
          source: "ingress",
          message: errorMessage,
          details: {
            messageId: message.messageId,
            sessionKey: message.sessionKey
          }
        });
      } catch (eventError) {
        console.warn("[qq-codex-bridge] failed to record runtime event", {
          error: eventError instanceof Error ? eventError.message : String(eventError)
        });
      }
      if (deps.errorEgress) {
        try {
          const errorDraft: OutboundDraft = {
            draftId: randomUUID(),
            sessionKey: message.sessionKey,
            text: `[桥接层错误] ${errorMessage}`,
            createdAt: new Date().toISOString(),
            replyToMessageId: message.messageId
          };
          await deps.errorEgress.deliver(errorDraft);
        } catch (replyError) {
          console.warn("[qq-codex-bridge] failed to send error reply", {
            replyError: replyError instanceof Error ? replyError.message : String(replyError)
          });
        }
      }
    }
  };
}

type BridgeRuntimeHandle = {
  shutdown(): Promise<void>;
  channels: string[];
  adminUrl: string;
};

type RuntimeShutdownDeps = {
  stopWorker(): void;
  ingresses: Array<{ stop?: () => Promise<void> | void }>;
  managedServices: Array<{ shutdown(): Promise<void> }>;
  closeHttpServer(): Promise<void>;
  desktopDriver?: { dispose?: () => void | Promise<void> };
  removeStateFile?: () => void | Promise<void>;
};

export function createRuntimeShutdown(deps: RuntimeShutdownDeps): () => Promise<void> {
  let shutdownPromise: Promise<void> | null = null;
  return () => {
    shutdownPromise ??= (async () => {
      deps.stopWorker();
      await Promise.allSettled([
        ...deps.ingresses.map((ingress) => Promise.resolve().then(() => ingress.stop?.())),
        ...deps.managedServices.map((service) => service.shutdown()),
        Promise.resolve().then(() => deps.desktopDriver?.dispose?.())
      ]);
      try {
        await deps.closeHttpServer();
      } finally {
        await deps.removeStateFile?.();
      }
    })();
    return shutdownPromise;
  };
}

export async function runBridgeDaemon(): Promise<BridgeRuntimeHandle> {
  const app = bootstrap();
  const adminRepository = new AdminRepository(app.db);
  const pushTargetRepository = app.push?.repository ?? new SqlitePushRepository(app.db);
  const startedAt = new Date().toISOString();
  const stateFilePath = path.join(path.dirname(app.config.databasePath), "bridge-daemon-state.json");
  const managedServices: Array<Pick<WeixinGatewayServiceHandle, "shutdown">> = [];
  const configuredAccountKeys = Object.keys(app.orchestrators.byAccountKey);
  let channels: string[] = [];
  const qqIngressHandlers = Object.entries(app.adapters.qqByAccountKey).map(([accountKey, adapter]) => {
    const orchestrator = app.orchestrators.byAccountKey[accountKey];
    if (!orchestrator) {
      throw new Error(`missing orchestrator for ${accountKey}`);
    }
    const threadCommandHandler = new ThreadCommandHandler({
      sessionStore: app.sessionStore,
      transcriptStore: app.transcriptStore,
      desktopDriver: app.adapters.codexDesktop,
      qqEgress: adapter.egress,
      chatgptDriver: app.chatgptDriver,
      accountKeys: configuredAccountKeys,
      push: app.push?.orchestrator
    });
    return {
      accountKey,
      adapter,
      ingressHandler: createIngressMessageHandler({
        threadCommandHandler,
        orchestrator,
        errorEgress: adapter.egress,
        runtimeEvents: adminRepository
      })
    };
  });
  const weixinRoutes = Object.entries(app.adapters.weixinByAccountKey).map(([accountKey, adapter]) => {
    const orchestrator = app.orchestrators.byAccountKey[accountKey];
    if (!orchestrator) {
      throw new Error(`missing orchestrator for ${accountKey}`);
    }
    const threadCommandHandler = new ThreadCommandHandler({
      sessionStore: app.sessionStore,
      transcriptStore: app.transcriptStore,
      desktopDriver: app.adapters.codexDesktop,
      qqEgress: adapter.egress,
      chatgptDriver: app.chatgptDriver,
      accountKeys: configuredAccountKeys,
      push: app.push?.orchestrator
    });
    return {
      accountKey,
      adapter,
      ingressHandler: createIngressMessageHandler({
        threadCommandHandler,
        orchestrator,
        errorEgress: adapter.egress,
        runtimeEvents: adminRepository
      })
    };
  });
  const feishuIngress = app.adapters.feishu && app.orchestrators.feishu
    ? (() => {
        const threadCommandHandler = new ThreadCommandHandler({
          sessionStore: app.sessionStore,
          transcriptStore: app.transcriptStore,
          desktopDriver: app.adapters.codexDesktop,
          qqEgress: app.adapters.feishu.egress,
          chatgptDriver: app.chatgptDriver,
          accountKeys: configuredAccountKeys,
          push: app.push?.orchestrator
        });
        return {
          accountKey: `feishu:${app.config.feishu.accountId}`,
          adapter: app.adapters.feishu,
          ingressHandler: createIngressMessageHandler({
            threadCommandHandler,
            orchestrator: app.orchestrators.feishu,
            errorEgress: app.adapters.feishu.egress,
            runtimeEvents: adminRepository
          })
        };
      })()
    : null;
  const bridgeHttpServer = createBridgeHttpServer([
    ...createAdminRoutes({
      config: app.config,
      repository: adminRepository,
      startedAt,
      getChannels: () => channels,
      pushTargets: pushTargetRepository
    }),
    ...(app.push
      ? createPushApiRoutes({
          token: app.push.token,
          orchestrator: app.push.orchestrator
        })
      : []),
    {
      routePath: INTERNAL_TURN_EVENT_PATH,
      allowOnlyLocal: true,
      dispatchPayload: async (payload) => {
        const event = payload as TurnEvent;
        await resolveTurnEventOrchestrator(event, app.orchestrators).handleTurnEvent(event);
      },
      onDispatchError: (error, payload) => {
        console.warn("[qq-codex-bridge] internal turn event dispatch failed", {
          error: error.message,
          payload
        });
        void adminRepository.recordEvent({
          level: "warn",
          source: "internal-turn-event",
          message: error.message,
          details: payload
        }).catch((eventError) => {
          console.warn("[qq-codex-bridge] failed to record runtime event", {
            error: eventError instanceof Error ? eventError.message : String(eventError)
          });
        });
      }
    },
    ...weixinRoutes.map((route) => ({
      routePath: route.adapter.webhook.routePath,
      dispatchPayload: async (payload: unknown) => {
        const message = route.adapter.webhook.toInboundMessage(payload);
        await route.ingressHandler(message);
      },
      onDispatchError: (error: Error, payload: unknown) => {
        console.warn("[qq-codex-bridge] weixin webhook dispatch failed", {
          accountKey: route.accountKey,
          error: error.message,
          payload
        });
        void adminRepository.recordEvent({
          level: "warn",
          source: "weixin-webhook",
          message: error.message,
          details: {
            accountKey: route.accountKey,
            payload
          }
        }).catch((eventError) => {
          console.warn("[qq-codex-bridge] failed to record runtime event", {
            error: eventError instanceof Error ? eventError.message : String(eventError)
          });
        });
      }
      }))
  ]);
  const startedIngresses: Array<{ stop?: () => Promise<void> | void }> = [];
  const shutdownStartedServices = createRuntimeShutdown({
    stopWorker: () => app.push?.worker.stop(),
    ingresses: startedIngresses,
    managedServices,
    desktopDriver: app.adapters.codexDesktop,
    removeStateFile: () => removeBridgeDaemonStateFile(stateFilePath, process.pid),
    closeHttpServer: async () => {
      if (bridgeHttpServer.listening) {
        await new Promise<void>((resolve) => bridgeHttpServer.close(() => resolve()));
      }
    }
  });

  let adminUrl = "";
  try {
    await new Promise<void>((resolve, reject) => {
      bridgeHttpServer.once("error", reject);
      bridgeHttpServer.listen(app.config.runtime.listenPort, app.config.runtime.listenHost, () => {
        bridgeHttpServer.off("error", reject);
        resolve();
      });
    });
    await app.push?.worker.start();

    for (const entry of qqIngressHandlers) {
      startedIngresses.push(entry.adapter.ingress);
      await entry.adapter.ingress.onMessage(entry.ingressHandler);
      await entry.adapter.ingress.start();
    }
    if (feishuIngress) {
      startedIngresses.push(feishuIngress.adapter.ingress);
      feishuIngress.adapter.ingress.onMessage(feishuIngress.ingressHandler);
      await feishuIngress.adapter.ingress.start();
    }

    const channelSet = new Set(qqIngressHandlers.map((entry) => entry.accountKey));
    if (feishuIngress) {
      channelSet.add(feishuIngress.accountKey);
    }
    if (app.config.weixin.enabled) {
      const weixinService = await startWeixinGatewayService();
      managedServices.push(weixinService);
      channelSet.add(`weixin:${weixinService.status.accountId}`);
      console.log("[qq-codex-bridge] channel ready", {
        channel: "weixin",
        listenHost: weixinService.status.listenHost,
        listenPort: weixinService.status.listenPort,
        loggedIn: weixinService.status.loggedIn,
        accountId: weixinService.status.accountId
      });
    }
    for (const route of weixinRoutes) {
      channelSet.add(route.accountKey);
    }
    channels = [...channelSet];
    adminUrl = `http://${app.config.runtime.listenHost}:${app.config.runtime.listenPort}/admin`;
    try {
      fs.writeFileSync(
        stateFilePath,
        JSON.stringify(
          {
            pid: process.pid,
            listenHost: app.config.runtime.listenHost,
            listenPort: app.config.runtime.listenPort,
            baseUrl: `http://${app.config.runtime.listenHost}:${app.config.runtime.listenPort}`,
            pushEnabled: app.config.push.enabled,
            pushToken: app.config.push.token ?? null,
            updatedAt: new Date().toISOString()
          },
          null,
          2
        ),
        "utf8"
      );
    } catch (stateError) {
      console.warn("[qq-codex-bridge] failed to write bridge daemon state file", {
        error: stateError instanceof Error ? stateError.message : String(stateError)
      });
    }
    await adminRepository.recordEvent({
      level: "info",
      source: "runtime",
      message: "bridge daemon ready",
      details: {
        channels,
        listenHost: app.config.runtime.listenHost,
        listenPort: app.config.runtime.listenPort,
        adminUrl
      }
    });

    console.log("[qq-codex-bridge] admin ready", {
      adminUrl
    });

    console.log("[qq-codex-bridge] ready", {
      transport: "qq-gateway-websocket",
      accountKeys: channels,
      conversationProvider: app.config.conversationProvider,
      listenHost: app.config.runtime.listenHost,
      listenPort: app.config.runtime.listenPort,
      adminUrl,
      internalTurnEventPath: INTERNAL_TURN_EVENT_PATH,
      ...(weixinRoutes.length > 0
        ? {
            weixinWebhookPaths: weixinRoutes.map((route) => route.adapter.webhook.routePath)
          }
        : {}),
      channels
    });
  } catch (error) {
    await shutdownStartedServices();
    throw error;
  }

  return {
    channels,
    adminUrl,
    shutdown: shutdownStartedServices
  };
}

export function removeBridgeDaemonStateFile(stateFilePath: string, pid: number): void {
  try {
    const state = JSON.parse(fs.readFileSync(stateFilePath, "utf8")) as Record<string, unknown>;
    if (state.pid !== pid) {
      return;
    }
    fs.unlinkSync(stateFilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.warn("[qq-codex-bridge] failed to remove bridge daemon state file", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

export function resolveTurnEventOrchestrator(
  event: Pick<TurnEvent, "sessionKey">,
  orchestrators: {
    qq: { handleTurnEvent: (event: TurnEvent) => Promise<void> | void };
    weixin?: { handleTurnEvent: (event: TurnEvent) => Promise<void> | void };
    byAccountKey?: Record<string, { handleTurnEvent: (event: TurnEvent) => Promise<void> | void }>;
  }
) {
  const accountKey = extractAccountKey(event.sessionKey);
  if (accountKey && orchestrators.byAccountKey?.[accountKey]) {
    return orchestrators.byAccountKey[accountKey];
  }

  if (event.sessionKey.startsWith("weixin:") && orchestrators.weixin) {
    return orchestrators.weixin;
  }

  return orchestrators.qq;
}

function extractAccountKey(sessionKey: string): string | null {
  const separatorIndex = sessionKey.indexOf("::");
  if (separatorIndex < 0) {
    return null;
  }
  const accountKey = sessionKey.slice(0, separatorIndex).trim();
  return accountKey || null;
}

function handleFatal(error: unknown) {
  const cause = error instanceof Error ? error.cause : undefined;
  console.error("[qq-codex-bridge] fatal:", error instanceof Error ? error.message : String(error));
  if (cause !== undefined) {
    console.error("  caused by:", cause);
  }
  if (error instanceof Error && error.stack) {
    console.error("  stack:", error.stack);
  }
  process.exitCode = 1;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runBridgeDaemon().catch(handleFatal);
}
