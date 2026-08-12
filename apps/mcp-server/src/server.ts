import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CHANNEL_FORMAT_GUIDE_TOOL_SUMMARY,
  enrichPushTargetsWithFormatGuide,
  listChannelFormatGuides,
  resolveChannelFormatGuide
} from "./channel-format-guide.js";
import { PushApiClient } from "./push-api-client.js";

const mediaSchema = z.object({
  type: z.enum(["image", "file", "audio", "video"]),
  path: z.string().min(1).describe(
    "Path to a REAL FILE that already exists inside the bridge's push outbox " +
      "directory (PUSH_OUTBOX_ROOT). This is a security sandbox: remote URLs, " +
      "file:// URIs, and any path outside the outbox are rejected. Before " +
      "calling this tool, copy/write the file into the outbox first, then pass " +
      "a path relative to the outbox root (or the resulting absolute path). " +
      "Do NOT put a raw local file path into `text` as a substitute for " +
      "attaching it here \u2014 the recipient cannot open a path on your machine; " +
      "the file will not actually be delivered unless it is referenced through " +
      "this `media` field. If a call fails with `media_sandbox_violation`, the " +
      "error message includes the exact outbox root path to copy the file into."
  )
});

const prioritySchema = z.enum(["normal", "urgent"]);

export function createPushMcpServer(client: PushApiClient): McpServer {
  const server = new McpServer({ name: "qq-codex-bridge-push", version: "0.2.0" });

  server.registerTool("push_message", {
    description:
      "Queue a message for a registered push target alias. " +
      CHANNEL_FORMAT_GUIDE_TOOL_SUMMARY +
      " Prefer format=markdown for feishu targets and format=plain for weixin. " +
      "Use get_channel_format_guide({ target }) or list_push_targets for per-target tips. " +
      "To attach an image/file/audio/video, DO NOT write its local path into `text` \u2014 " +
      "copy the file into the bridge's push outbox directory first and reference it via " +
      "the `media` array (see its field description for the exact rule); paths " +
      "outside the outbox are rejected with `media_sandbox_violation`.",
    inputSchema: {
      target: z.string().min(1).max(128),
      text: z.string().max(100_000).default(""),
      format: z.enum(["plain", "markdown"]).default("plain").describe(
        "Message body format. Default remains plain for safety. " +
          "feishu: use markdown for headings/lists/tables/code/links (rendered via post md). " +
          "weixin: keep plain; markdown syntax usually appears literally. " +
          "qq: proactive push is currently unsupported regardless of format."
      ),
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
    description:
      "Queue an idempotent task status report for a registered target alias. " +
      "Body is currently sent as plain text. For feishu, prefer push_message with " +
      "format=markdown if you need tables/headings; for weixin keep concise plain prose. " +
      CHANNEL_FORMAT_GUIDE_TOOL_SUMMARY,
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
    description:
      "List registered push target aliases without provider identifiers. " +
      "Each target includes recommendedFormat and formatSummary from the channel guide. " +
      CHANNEL_FORMAT_GUIDE_TOOL_SUMMARY,
    inputSchema: {}
  }, async () => toolResult(async () => {
    const payload = await client.listTargets();
    if (payload && typeof payload === "object") {
      return enrichPushTargetsWithFormatGuide(payload as { targets?: Array<{ alias: string; channel: string }> });
    }
    return payload;
  }));

  server.registerTool("get_channel_format_guide", {
    description:
      "Return bot-channel message formatting rules for Agent push composition. " +
      "Omit filters to get all channels; pass channel=feishu|weixin|qq, or target=<alias> " +
      "to resolve via list_push_targets. Use this before writing rich text for push_message.",
    inputSchema: {
      channel: z.enum(["feishu", "weixin", "qq"]).optional(),
      target: z.string().min(1).max(128).optional()
    }
  }, async (input) => toolResult(async () => {
    if (!input.channel && !input.target) {
      return { guides: listChannelFormatGuides() };
    }
    let targets: Array<{ alias: string; channel: string }> | undefined;
    if (input.target && !input.channel) {
      const payload = await client.listTargets();
      targets = extractTargets(payload);
    }
    const guide = resolveChannelFormatGuide({
      channel: input.channel,
      target: input.target,
      targets
    });
    if (!guide) {
      throw new Error(
        input.target
          ? `unknown push target alias: ${input.target}`
          : `unknown channel: ${input.channel ?? ""}`
      );
    }
    return { guide };
  }));

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

function extractTargets(payload: unknown): Array<{ alias: string; channel: string }> {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const targets = (payload as { targets?: unknown }).targets;
  if (!Array.isArray(targets)) {
    return [];
  }
  return targets.filter(
    (item): item is { alias: string; channel: string } =>
      Boolean(item)
      && typeof item === "object"
      && typeof (item as { alias?: unknown }).alias === "string"
      && typeof (item as { channel?: unknown }).channel === "string"
  );
}
