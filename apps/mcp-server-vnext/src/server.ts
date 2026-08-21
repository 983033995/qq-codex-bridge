import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  RuntimeDiagnostic,
  RuntimeStatus
} from "../../../packages/runtime-manager/src/index.js";
import { z } from "zod";
import type { GatewayControlClient } from "./control-api-client.js";

export type RuntimeManagerPort = {
  ensureRunning(): Promise<RuntimeStatus>;
  getStatus(): Promise<RuntimeStatus>;
  restart(): Promise<RuntimeStatus>;
  doctor(): Promise<RuntimeDiagnostic[]>;
};

export function createGatewayMcpServer(
  runtime: RuntimeManagerPort,
  control?: GatewayControlClient
): McpServer {
  const server = new McpServer({ name: "OmniAgent Gateway MCP", version: "0.3.0" });

  server.registerTool("get_runtime_status", {
    description: "Get the local OmniAgent Gateway Runtime status.",
    inputSchema: {}
  }, async () => toolResult(() => runtime.getStatus()));

  server.registerTool("doctor", {
    description: "Run local Runtime diagnostics and return actionable findings.",
    inputSchema: {}
  }, async () => toolResult(async () => ({ diagnostics: await runtime.doctor() })));

  server.registerTool("restart_runtime", {
    description: "Gracefully restart the local OmniAgent Gateway Runtime.",
    inputSchema: {}
  }, async () => toolResult(() => runtime.restart()));

  server.registerTool("get_admin_url", {
    description: "Ensure the Runtime is ready and return its local Control Center URL.",
    inputSchema: {}
  }, async () => toolResult(async () => {
    const status = await runtime.ensureRunning();
    return { url: status.baseUrl, state: status.state };
  }));

  if (control) {
    server.registerTool("list_approvals", {
      description: "List auditable Codex approval requests, optionally filtered by status or thread.",
      inputSchema: {
        status: z.enum(["pending", "resolving", "approved", "declined", "cancelled"]).optional(),
        threadId: z.string().trim().min(1).max(256).optional(),
        limit: z.number().int().min(1).max(200).default(50)
      }
    }, async (input) => toolResult(async () => ({ approvals: await control.listApprovals(input) })));

    server.registerTool("resolve_approval", {
      description: "Approve or decline one pending Codex command execution or file change request.",
      inputSchema: {
        approvalId: z.string().trim().min(1).max(256),
        resolution: z.enum(["approve", "decline"])
      }
    }, async ({ approvalId, resolution }) => toolResult(() => control.resolveApproval(approvalId, resolution)));

    server.registerTool("get_setup_status", {
      description: "List persistent QQ, Weixin, or Feishu setup sessions without exposing secrets.",
      inputSchema: {
        channel: z.enum(["qq", "weixin", "feishu"]).optional(),
        accountId: z.string().trim().min(1).max(128).optional()
      }
    }, async (input) => toolResult(async () => ({ sessions: await control.listSetup(input) })));

    server.registerTool("start_setup", {
      description: "Start channel setup. Weixin returns a QR artifact; QQ and Feishu return required fields.",
      inputSchema: {
        channel: z.enum(["qq", "weixin", "feishu"]),
        accountId: z.string().trim().min(1).max(128),
        force: z.boolean().default(false)
      }
    }, async (input) => toolResult(() => control.startSetup(input)));

    server.registerTool("submit_setup", {
      description: "Submit QQ or Feishu credentials. Secrets are write-only and are never returned.",
      inputSchema: {
        setupId: z.string().trim().min(1).max(256),
        appId: z.string().trim().min(1).max(256),
        clientSecret: z.string().min(1).max(4096)
      }
    }, async ({ setupId, appId, clientSecret }) => toolResult(async () => {
      let session = await control.submitSetup(setupId, { appId, clientSecret });
      if (session.status === "restart_required") {
        const status = await runtime.restart();
        if (!status.baseUrl) throw new Error("Runtime restart did not return a Control API URL");
        control.reset(status.baseUrl);
        session = await control.getSetup(setupId);
      }
      return session;
    }));

    server.registerTool("get_setup_progress", {
      description: "Get one persistent setup session and its current QR or channel status.",
      inputSchema: { setupId: z.string().trim().min(1).max(256) }
    }, async ({ setupId }) => toolResult(() => control.getSetup(setupId)));

    server.registerTool("cancel_setup", {
      description: "Cancel an unfinished setup session.",
      inputSchema: { setupId: z.string().trim().min(1).max(256) }
    }, async ({ setupId }) => toolResult(() => control.cancelSetup(setupId)));
  }

  return server;
}

async function toolResult(work: () => Promise<unknown>) {
  try {
    const value = await work();
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
  } catch (error) {
    return {
      content: [{
        type: "text" as const,
        text: error instanceof Error ? error.message : "OmniAgent Gateway operation failed"
      }],
      isError: true
    };
  }
}
