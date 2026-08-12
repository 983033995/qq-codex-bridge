import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PushApiClient } from "../../apps/mcp-server/src/push-api-client.js";
import { resolveMcpPushOptions } from "../../apps/mcp-server/src/cli.js";
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
      "get_channel_format_guide",
      "get_push_status",
      "list_push_targets",
      "push_message",
      "push_task_report"
    ]);
    const pushMessage = tools.tools.find((tool) => tool.name === "push_message");
    expect(pushMessage?.description ?? "").toMatch(/feishu→markdown|feishu.*markdown/i);
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

  it("exposes channel format guides and enriches list_push_targets", async () => {
    const targetsPayload = {
      targets: [
        { alias: "feishu-bot", channel: "feishu", enabled: true },
        { alias: "weixin-bot", channel: "weixin", enabled: true }
      ]
    };
    const fetchFn = vi.fn().mockImplementation(async () => new Response(JSON.stringify(targetsPayload), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
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

    const allGuides = await client.callTool({ name: "get_channel_format_guide", arguments: {} });
    expect(allGuides.isError).not.toBe(true);
    const allPayload = JSON.parse(String((allGuides.content as Array<{ text: string }>)[0].text)) as {
      guides: Array<{ channel: string; recommendedFormat: string }>;
    };
    expect(allPayload.guides.map((guide) => guide.channel).sort()).toEqual(["feishu", "qq", "weixin"]);

    const feishuGuide = await client.callTool({
      name: "get_channel_format_guide",
      arguments: { channel: "feishu" }
    });
    expect(JSON.parse(String((feishuGuide.content as Array<{ text: string }>)[0].text))).toMatchObject({
      guide: { channel: "feishu", recommendedFormat: "markdown" }
    });

    const byTarget = await client.callTool({
      name: "get_channel_format_guide",
      arguments: { target: "weixin-bot" }
    });
    expect(JSON.parse(String((byTarget.content as Array<{ text: string }>)[0].text))).toMatchObject({
      guide: { channel: "weixin", recommendedFormat: "plain" }
    });

    const listed = await client.callTool({ name: "list_push_targets", arguments: {} });
    const listedPayload = JSON.parse(String((listed.content as Array<{ text: string }>)[0].text)) as {
      targets: Array<Record<string, unknown>>;
    };
    expect(listedPayload.targets[0]).toMatchObject({
      alias: "feishu-bot",
      recommendedFormat: "markdown",
      formatSummary: expect.any(String)
    });
    expect(listedPayload.targets[1]).toMatchObject({
      alias: "weixin-bot",
      recommendedFormat: "plain"
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

  it("preserves the network failure cause when the local push API is unavailable", async () => {
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:3101");
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("fetch failed", { cause }));
    const client = new PushApiClient({
      baseUrl: "http://127.0.0.1:3101",
      token: "0123456789abcdef0123456789abcdef",
      fetchFn
    });

    await expect(client.listTargets()).rejects.toThrow(
      "push API is unavailable at http://127.0.0.1:3101: connect ECONNREFUSED 127.0.0.1:3101"
    );
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

  it("auto-discovers base URL and token from bridge daemon state file when env is not set", () => {
    const tempDir = fs.mkdtempSync("/tmp/mcp-test-");
    const runtimeDir = `${tempDir}/runtime`;
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(`${runtimeDir}/bridge-daemon-state.json`, JSON.stringify({
      pid: process.pid,
      baseUrl: "http://127.0.0.1:3109",
      pushToken: "0123456789abcdef0123456789abcdef"
    }));

    const resolved = resolveMcpPushOptions({}, tempDir);
    expect(resolved).toEqual({
      baseUrl: "http://127.0.0.1:3109",
      token: "0123456789abcdef0123456789abcdef"
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("ignores a daemon state file whose process is no longer running", () => {
    const tempDir = fs.mkdtempSync("/tmp/mcp-test-");
    const runtimeDir = `${tempDir}/runtime`;
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(`${runtimeDir}/bridge-daemon-state.json`, JSON.stringify({
      pid: 999999,
      baseUrl: "http://127.0.0.1:3109",
      pushToken: "stale-stale-stale-stale-stale-stale"
    }));
    fs.writeFileSync(`${tempDir}/.env`, [
      "QQ_CODEX_LISTEN_HOST=127.0.0.1",
      "QQ_CODEX_LISTEN_PORT=3110",
      "PUSH_TOKEN=0123456789abcdef0123456789abcdef"
    ].join("\n"));

    const resolved = resolveMcpPushOptions({}, tempDir, { isProcessRunning: () => false });
    expect(resolved).toEqual({
      baseUrl: "http://127.0.0.1:3110",
      token: "0123456789abcdef0123456789abcdef"
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
