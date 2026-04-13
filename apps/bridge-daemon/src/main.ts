import { pathToFileURL } from "node:url";
import type { InboundMessage, TurnEvent } from "../../../packages/domain/src/message.js";
import { bootstrap, INTERNAL_TURN_EVENT_PATH } from "./bootstrap.js";
import { createBridgeHttpServer } from "./http-server.js";
import { ThreadCommandHandler } from "./thread-command-handler.js";

type IngressMessageHandlerDeps = {
  threadCommandHandler: Pick<ThreadCommandHandler, "handleIfCommand">;
  orchestrator: {
    handleInbound: (message: InboundMessage) => Promise<void>;
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
      console.error("[qq-codex-bridge] message handling failed", {
        messageId: message.messageId,
        sessionKey: message.sessionKey,
        error: error instanceof Error ? error.message : String(error)
      });
      if (error instanceof Error && error.stack) {
        console.error("  stack:", error.stack);
      }
    }
  };
}

export async function runBridgeDaemon() {
  const app = bootstrap();
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
        orchestrator: weixinOrchestrator
      })
    : null;
  const bridgeHttpServer = createBridgeHttpServer([
    {
      routePath: INTERNAL_TURN_EVENT_PATH,
      allowOnlyLocal: true,
      dispatchPayload: async (payload) => {
        await app.orchestrators.qq.handleTurnEvent(payload as TurnEvent);
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
      orchestrator: app.orchestrators.qq
    })
  );

  await app.adapters.qq.ingress.start();

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
      : {})
  });
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
