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
  const qqThreadCommandHandler = new ThreadCommandHandler({
    sessionStore: app.sessionStore,
    transcriptStore: app.transcriptStore,
    desktopDriver: app.adapters.codexDesktop,
    qqEgress: app.adapters.qq.egress
  });
  const weixinAdapter = app.adapters.weixin;
  const weixinOrchestrator = app.orchestrators.weixin;
  const weixinThreadCommandHandler = weixinAdapter && weixinOrchestrator
    ? new ThreadCommandHandler({
        sessionStore: app.sessionStore,
        transcriptStore: app.transcriptStore,
        desktopDriver: app.adapters.codexDesktop,
        qqEgress: weixinAdapter.egress
      })
    : null;
  const weixinIngressHandler = weixinThreadCommandHandler && weixinOrchestrator
    ? createIngressMessageHandler({
        threadCommandHandler: weixinThreadCommandHandler,
        orchestrator: weixinOrchestrator,
        errorEgress: weixinAdapter!.egress
      })
    : null;
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
    ...(weixinAdapter && weixinIngressHandler
      ? [
          {
            routePath: app.config.weixin.webhookPath,
            dispatchPayload: async (payload: unknown) => {
              const message = weixinAdapter.webhook.toInboundMessage(payload);
              await weixinIngressHandler(message);
            },
            onDispatchError: (error: Error, payload: unknown) => {
              console.warn("[qq-codex-bridge] weixin webhook dispatch failed", {
                error: error.message,
                payload
              });
            }
          }
        ]
      : [])
  ]);

  await new Promise<void>((resolve, reject) => {
    bridgeHttpServer.once("error", reject);
    bridgeHttpServer.listen(app.config.runtime.listenPort, app.config.runtime.listenHost, () => {
      bridgeHttpServer.off("error", reject);
      resolve();
    });
  });

  await app.adapters.qq.ingress.onMessage(
    createIngressMessageHandler({
      threadCommandHandler: qqThreadCommandHandler,
      orchestrator: app.orchestrators.qq,
      errorEgress: app.adapters.qq.egress
    })
  );

  await app.adapters.qq.ingress.start();

  const channels = ["qq"];
  if (app.config.weixin.enabled) {
    const weixinService = await startWeixinGatewayService();
    managedServices.push(weixinService);
    channels.push("weixin");
    console.log("[qq-codex-bridge] channel ready", {
      channel: "weixin",
      listenHost: weixinService.status.listenHost,
      listenPort: weixinService.status.listenPort,
      loggedIn: weixinService.status.loggedIn,
      accountId: weixinService.status.accountId
    });
  }

  console.log("[qq-codex-bridge] ready", {
    transport: "qq-gateway-websocket",
    accountKey: "qqbot:default",
    listenHost: app.config.runtime.listenHost,
    listenPort: app.config.runtime.listenPort,
    internalTurnEventPath: INTERNAL_TURN_EVENT_PATH,
    ...(weixinThreadCommandHandler
      ? {
          weixinWebhookPath: app.config.weixin.webhookPath
        }
      : {}),
    channels
  });

  return {
    channels,
    shutdown: async () => {
      await Promise.allSettled([
        new Promise<void>((resolve) => {
          const maybeClose = app.adapters.qq.ingress as { stop?: () => Promise<void> | void };
          Promise.resolve(maybeClose.stop?.()).finally(() => resolve());
        }),
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
  }
) {
  if (event.sessionKey.startsWith("weixin:") && orchestrators.weixin) {
    return orchestrators.weixin;
  }

  return orchestrators.qq;
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
