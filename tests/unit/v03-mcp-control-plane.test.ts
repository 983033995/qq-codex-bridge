import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayMcpServer } from "../../apps/mcp-server-vnext/src/server.js";
import type { RuntimeStatus } from "../../packages/runtime-manager/src/index.js";
import type { SetupSession } from "../../packages/setup/src/index.js";
import type { ApprovalRequest } from "../../packages/approval/src/index.js";

describe("v0.3 MCP Runtime control plane", () => {
  const closeables: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.allSettled(closeables.splice(0).map((item) => item.close()));
  });

  it("exposes Runtime system tools and maps them to the shared manager", async () => {
    const ready = runtimeStatus();
    const runtime = {
      ensureRunning: vi.fn(async () => ready),
      getStatus: vi.fn(async () => ready),
      restart: vi.fn(async () => ready),
      doctor: vi.fn(async () => [{ code: "RUNTIME_READY", status: "ok" as const, message: "ready" }])
    };
    const server = createGatewayMcpServer(runtime);
    const client = new Client({ name: "test", version: "1.0.0" });
    closeables.push(server, client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "doctor",
      "get_admin_url",
      "get_runtime_status",
      "restart_runtime"
    ]);

    const status = await client.callTool({ name: "get_runtime_status", arguments: {} });
    const admin = await client.callTool({ name: "get_admin_url", arguments: {} });
    await client.callTool({ name: "doctor", arguments: {} });
    await client.callTool({ name: "restart_runtime", arguments: {} });

    expect(JSON.parse(text(status))).toMatchObject({ state: "ready", pid: 4242 });
    expect(JSON.parse(text(admin))).toEqual({ url: "http://127.0.0.1:3100", state: "ready" });
    expect(runtime.getStatus).toHaveBeenCalledTimes(1);
    expect(runtime.ensureRunning).toHaveBeenCalledTimes(1);
    expect(runtime.doctor).toHaveBeenCalledTimes(1);
    expect(runtime.restart).toHaveBeenCalledTimes(1);
  });

  it("exposes persistent Setup tools, restarts when required, and never returns submitted secrets", async () => {
    const awaiting: SetupSession = {
      setupId: "setup-1",
      channel: "feishu",
      accountId: "team",
      status: "awaiting_input",
      message: "请输入配置",
      artifact: { type: "form", fields: [{ name: "clientSecret", secret: true, required: true }] },
      errorCode: null,
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z"
    };
    const restartRequired = { ...awaiting, status: "restart_required" as const, artifact: null };
    const connected = { ...awaiting, status: "connected" as const, artifact: null };
    const pendingApproval: ApprovalRequest = {
      approvalId: "approval-1",
      requestKey: "request-1",
      appServerRequestId: 42,
      kind: "command_execution",
      method: "item/commandExecution/requestApproval",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      reason: "run tests",
      command: "pnpm test",
      cwd: "/workspace",
      grantRoot: null,
      params: {},
      status: "pending",
      resolution: null,
      error: null,
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
      resolvedAt: null
    };
    const runtime = {
      ensureRunning: vi.fn(async () => runtimeStatus()),
      getStatus: vi.fn(async () => runtimeStatus()),
      restart: vi.fn(async () => runtimeStatus()),
      doctor: vi.fn(async () => [])
    };
    const control = {
      reset: vi.fn(),
      listApprovals: vi.fn(async () => [pendingApproval]),
      getApproval: vi.fn(async () => pendingApproval),
      resolveApproval: vi.fn(async (_approvalId: string, resolution: "approve" | "decline") => ({
        ...pendingApproval,
        status: "resolving" as const,
        resolution
      })),
      listSetup: vi.fn(async () => [awaiting]),
      getSetup: vi.fn(async () => connected),
      startSetup: vi.fn(async () => awaiting),
      submitSetup: vi.fn(async () => restartRequired),
      cancelSetup: vi.fn(async () => ({ ...awaiting, status: "cancelled" as const }))
    };
    const server = createGatewayMcpServer(runtime, control);
    const client = new Client({ name: "test", version: "1.0.0" });
    closeables.push(server, client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "get_setup_status",
      "start_setup",
      "submit_setup",
      "get_setup_progress",
      "cancel_setup",
      "list_approvals",
      "resolve_approval"
    ]));
    const submitted = await client.callTool({
      name: "submit_setup",
      arguments: { setupId: "setup-1", appId: "cli_app", clientSecret: "never-echo-me" }
    });
    const approvals = await client.callTool({
      name: "list_approvals",
      arguments: { status: "pending", threadId: "thread-1", limit: 25 }
    });
    const resolved = await client.callTool({
      name: "resolve_approval",
      arguments: { approvalId: "approval-1", resolution: "approve" }
    });

    expect(submitted.isError).not.toBe(true);
    expect(text(submitted)).not.toContain("never-echo-me");
    expect(runtime.restart).toHaveBeenCalledTimes(1);
    expect(control.reset).toHaveBeenCalledWith("http://127.0.0.1:3100");
    expect(control.getSetup).toHaveBeenCalledWith("setup-1");
    expect(JSON.parse(text(approvals))).toMatchObject({ approvals: [{ approvalId: "approval-1" }] });
    expect(JSON.parse(text(resolved))).toMatchObject({
      approvalId: "approval-1",
      status: "resolving",
      resolution: "approve"
    });
    expect(control.resolveApproval).toHaveBeenCalledWith("approval-1", "approve");
  });
});

function runtimeStatus(): RuntimeStatus {
  return {
    state: "ready",
    pid: 4242,
    baseUrl: "http://127.0.0.1:3100",
    startedAt: "2026-08-13T00:00:00.000Z",
    checkedAt: "2026-08-13T00:00:01.000Z",
    reused: false,
    message: "ready"
  };
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return String((result.content as Array<{ text: string }>)[0]!.text);
}
