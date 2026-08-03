import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PushApiClient } from "./push-api-client.js";

const mediaSchema = z.object({
  type: z.enum(["image", "file", "audio", "video"]),
  path: z.string().min(1)
});

const prioritySchema = z.enum(["normal", "urgent"]);

export function createPushMcpServer(client: PushApiClient): McpServer {
  const server = new McpServer({ name: "qq-codex-bridge-push", version: "0.2.0" });

  server.registerTool("push_message", {
    description: "Queue a message for a registered push target alias.",
    inputSchema: {
      target: z.string().min(1).max(128),
      text: z.string().max(100_000).default(""),
      format: z.enum(["plain", "markdown"]).default("plain"),
      media: z.array(mediaSchema).max(16).default([]),
      source: z.string().max(128).default("agent"),
      taskId: z.string().max(256).optional(),
      priority: prioritySchema.default("normal"),
      idempotencyKey: z.string().min(1).max(256)
    }
  }, async (input) => toolResult(() => client.push(input.idempotencyKey, {
    target: input.target,
    message: { text: input.text, format: input.format, media: input.media },
    metadata: {
      source: input.source,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      priority: input.priority
    }
  })));

  server.registerTool("push_task_report", {
    description: "Queue an idempotent task status report for a registered target alias.",
    inputSchema: {
      target: z.string().min(1).max(128),
      taskId: z.string().min(1).max(256),
      status: z.enum(["running", "completed", "failed"]),
      summary: z.string().min(1).max(100_000),
      details: z.string().max(100_000).optional(),
      source: z.string().max(128).default("agent"),
      priority: prioritySchema.default("normal"),
      idempotencyKey: z.string().min(1).max(256).optional()
    }
  }, async (input) => {
    const text = input.details ? `${input.summary}\n\n${input.details}` : input.summary;
    const idempotencyKey = input.idempotencyKey ?? stableTaskReportKey(input);
    return toolResult(() => client.push(idempotencyKey, {
      target: input.target,
      message: { text, format: "plain", media: [] },
      metadata: {
        source: input.source,
        taskId: input.taskId,
        priority: input.priority,
        taskStatus: input.status
      }
    }));
  });

  server.registerTool("list_push_targets", {
    description: "List registered push target aliases without provider identifiers.",
    inputSchema: {}
  }, async () => toolResult(() => client.listTargets()));

  server.registerTool("get_push_status", {
    description: "Get the delivery status of a queued push job.",
    inputSchema: { pushId: z.string().min(1).max(256) }
  }, async ({ pushId }) => toolResult(() => client.getStatus(pushId)));

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
        text: error instanceof Error ? error.message : "push operation failed"
      }],
      isError: true
    };
  }
}

function stableTaskReportKey(input: {
  target: string;
  taskId: string;
  status: string;
  source: string;
}): string {
  return `task-report-${createHash("sha256")
    .update(`${input.source}\0${input.target}\0${input.taskId}\0${input.status}`)
    .digest("hex")}`;
}
