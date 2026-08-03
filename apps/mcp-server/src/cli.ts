import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PushApiClient } from "./push-api-client.js";
import { createPushMcpServer } from "./server.js";

export async function runPushMcpServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const client = new PushApiClient({
    baseUrl: env.MCP_PUSH_BASE_URL ?? "http://127.0.0.1:3100",
    token: env.MCP_PUSH_TOKEN ?? env.PUSH_TOKEN ?? ""
  });
  await createPushMcpServer(client).connect(new StdioServerTransport());
}

void runPushMcpServer().catch((error) => {
  process.stderr.write(`[qq-codex-mcp] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
