import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { RuntimeManager } from "../../../packages/runtime-manager/src/index.js";
import { createGatewayMcpServer, type RuntimeManagerPort } from "./server.js";
import { LocalControlApiClient } from "./control-api-client.js";

export async function runGatewayMcpServer(runtime: RuntimeManagerPort = new RuntimeManager()): Promise<void> {
  const status = await runtime.ensureRunning();
  if (!status.baseUrl) throw new Error("Runtime did not expose a local Control API URL");
  const control = new LocalControlApiClient({ baseUrl: status.baseUrl });
  await createGatewayMcpServer(runtime, control).connect(new StdioServerTransport());
}

if (isEntrypoint()) {
  runGatewayMcpServer().catch((error) => {
    process.stderr.write(`[OmniAgent Gateway MCP] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

function isEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && import.meta.url === pathToFileURL(entrypoint).href);
}
