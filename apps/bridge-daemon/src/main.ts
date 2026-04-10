import { pathToFileURL } from "node:url";
import type { InboundMessage } from "../../../packages/domain/src/message.js";
import { bootstrap } from "./bootstrap.js";
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
  const threadCommandHandler = new ThreadCommandHandler({
    sessionStore: app.sessionStore,
    transcriptStore: app.transcriptStore,
    desktopDriver: app.adapters.codexDesktop,
    qqEgress: app.adapters.qq.egress
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
    accountKey: "qqbot:default"
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
