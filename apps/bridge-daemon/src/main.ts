import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { InboundMessage, OutboundDraft, TurnEvent } from "../../../packages/domain/src/message.js";
import { bootstrap, INTERNAL_TURN_EVENT_PATH } from "./bootstrap.js";
import { createBridgeHttpServer } from "./http-server.js";
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
};

export async function runBridgeDaemon(): Promise<BridgeRuntimeHandle> {
  const app = bootstrap();
  const managedServices: Array<Pick<WeixinGatewayServiceHandle, "shutdown">> = [];
  const configuredAccountKeys = Object.keys(app.orchestrators.byAccountKey);
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
      accountKeys: configuredAccountKeys
    });
    return {
      accountKey,
      adapter,
      ingressHandler: createIngressMessageHandler({
        threadCommandHandler,
        orchestrator,
        errorEgress: adapter.egress
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
      accountKeys: configuredAccountKeys
    });
    return {
      accountKey,
      adapter,
      ingressHandler: createIngressMessageHandler({
        threadCommandHandler,
        orchestrator,
        errorEgress: adapter.egress
      })
    };
  });
  const bridgeHttpServer = createBridgeHttpServer([
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
      }
    }))
  ]);

  await new Promise<void>((resolve, reject) => {
    bridgeHttpServer.once("error", reject);
    bridgeHttpServer.listen(app.config.runtime.listenPort, app.config.runtime.listenHost, () => {
      bridgeHttpServer.off("error", reject);
      resolve();
    });
  });

  for (const entry of qqIngressHandlers) {
    await entry.adapter.ingress.onMessage(entry.ingressHandler);
    await entry.adapter.ingress.start();
  }

  const channelSet = new Set(qqIngressHandlers.map((entry) => entry.accountKey));
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
  const channels = [...channelSet];

  console.log("[qq-codex-bridge] ready", {
    transport: "qq-gateway-websocket",
    accountKeys: channels,
    conversationProvider: app.config.conversationProvider,
    listenHost: app.config.runtime.listenHost,
    listenPort: app.config.runtime.listenPort,
    internalTurnEventPath: INTERNAL_TURN_EVENT_PATH,
    ...(weixinRoutes.length > 0
      ? {
          weixinWebhookPaths: weixinRoutes.map((route) => route.adapter.webhook.routePath)
        }
      : {}),
    channels
  });

  return {
    channels,
    shutdown: async () => {
      await Promise.allSettled([
        ...qqIngressHandlers.map((entry) =>
          new Promise<void>((resolve) => {
            const maybeClose = entry.adapter.ingress as { stop?: () => Promise<void> | void };
            Promise.resolve(maybeClose.stop?.()).finally(() => resolve());
          })
        ),
        ...managedServices.map((service) => service.shutdown())
      ]);
      await new Promise<void>((resolve) => bridgeHttpServer.close(() => resolve()));
    }
  };
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
