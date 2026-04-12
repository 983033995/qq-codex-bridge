import { pathToFileURL } from "node:url";
import type { InboundMessage, TurnEvent } from "../../../packages/domain/src/message.js";
import { bootstrap, INTERNAL_TURN_EVENT_PATH } from "./bootstrap.js";
import { createInternalTurnEventServer } from "./http-server.js";
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
  const internalTurnEventServer = createInternalTurnEventServer({
    routePath: INTERNAL_TURN_EVENT_PATH,
    ingress: {
      dispatchTurnEvent: async (payload) => {
        await app.orchestrator.handleTurnEvent(payload as TurnEvent);
      }
    },
    onDispatchError: (error, payload) => {
      console.warn("[qq-codex-bridge] internal turn event dispatch failed", {
        error: error.message,
        payload
      });
    }
  });
  const threadCommandHandler = new ThreadCommandHandler({
    sessionStore: app.sessionStore,
    transcriptStore: app.transcriptStore,
    desktopDriver: app.adapters.codexDesktop,
    qqEgress: app.adapters.qq.egress
  });

  await new Promise<void>((resolve, reject) => {
    internalTurnEventServer.once("error", reject);
    internalTurnEventServer.listen(app.config.runtime.listenPort, "127.0.0.1", () => {
      internalTurnEventServer.off("error", reject);
      resolve();
    });
  });

  await app.adapters.qq.ingress.onMessage(
    createIngressMessageHandler({
      threadCommandHandler,
      orchestrator: app.orchestrator
    })
  );

  await app.adapters.qq.ingress.start();

  console.log("[qq-codex-bridge] ready", {
    transport: "qq-gateway-websocket",
    accountKey: "qqbot:default",
    internalTurnEventPath: INTERNAL_TURN_EVENT_PATH
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
