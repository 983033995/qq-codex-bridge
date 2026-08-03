import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PushApiClient } from "../../apps/mcp-server/src/push-api-client.js";
import { createPushMcpServer } from "../../apps/mcp-server/src/server.js";

describe("MCP push server", () => {
  const closeables: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.allSettled(closeables.splice(0).map((item) => item.close()));
  });

  it("exposes the fixed tool set and forwards task reports through the authenticated push API", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      pushId: "push-mcp-1",
      status: "queued",
      duplicate: false
    }), { status: 202, headers: { "content-type": "application/json" } }));
    const pushClient = new PushApiClient({
      baseUrl: "http://127.0.0.1:3100/",
      token: "0123456789abcdef0123456789abcdef",
      fetchFn
    });
    const server = createPushMcpServer(pushClient);
    const client = new Client({ name: "test", version: "1.0.0" });
    closeables.push(server, client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "get_push_status",
      "list_push_targets",
      "push_message",
      "push_task_report"
    ]);
    const result = await client.callTool({
      name: "push_task_report",
      arguments: {
        target: "daily-report-group",
        taskId: "task-123",
        status: "completed",
        summary: "任务完成",
        source: "codex"
      }
    });
    expect(result.isError).not.toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3100/api/v1/push");
    expect(init.headers).toMatchObject({
      authorization: "Bearer 0123456789abcdef0123456789abcdef",
      "content-type": "application/json"
    });
    expect(init.headers).toHaveProperty("idempotency-key", expect.stringMatching(/^task-report-/));
    expect(JSON.parse(String(init.body))).toMatchObject({
      target: "daily-report-group",
      metadata: { source: "codex", taskId: "task-123", taskStatus: "completed" }
    });
  });

  it("returns sanitized tool errors without exposing the bearer token", async () => {
    const token = "0123456789abcdef0123456789abcdef";
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: "target not found" }
    }), { status: 404 }));
    const pushClient = new PushApiClient({ baseUrl: "http://127.0.0.1:3100", token, fetchFn });
    const server = createPushMcpServer(pushClient);
    const client = new Client({ name: "test", version: "1.0.0" });
    closeables.push(server, client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: "list_push_targets", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("target not found");
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("refuses remote or credential-bearing API URLs before attaching the bearer token", () => {
    const token = "0123456789abcdef0123456789abcdef";
    expect(() => new PushApiClient({
      baseUrl: "https://push.example.com",
      token
    })).toThrow(/loopback host/);
    expect(() => new PushApiClient({
      baseUrl: "http://user:password@127.0.0.1:3100",
      token
    })).toThrow(/without embedded credentials/);
    expect(() => new PushApiClient({
      baseUrl: "http://127.0.0.2:3100",
      token
    })).not.toThrow();
  });
});
