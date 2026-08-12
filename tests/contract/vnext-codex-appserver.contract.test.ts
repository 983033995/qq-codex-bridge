import { afterEach } from "vitest";
import { CodexAppServerAdapter } from "../../packages/codex-appserver/src/index.js";
import { FakeCodexAppServer } from "../support/fake-app-server.js";
import { codexPortContract } from "./support/vnext-port-contracts.js";

const adapters: CodexAppServerAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()));
});

codexPortContract("vNext Codex AppServer adapter", () => {
  const server = new FakeCodexAppServer();
  const adapter = new CodexAppServerAdapter({
    endpointProvider: staticEndpointProvider(),
    createWebSocket: () => server.connect() as never,
    requestTimeoutMs: 1_000
  });
  adapters.push(adapter);
  return adapter;
});

function staticEndpointProvider() {
  return {
    async resolve() {
      return { url: "ws://127.0.0.1:1", managed: false };
    },
    dispose() {}
  };
}
