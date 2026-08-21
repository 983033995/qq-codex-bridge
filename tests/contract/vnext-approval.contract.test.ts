import { afterEach, describe, expect, it } from "vitest";
import { ApprovalService } from "../../packages/approval/src/index.js";
import { CodexAppServerAdapter } from "../../packages/codex-appserver/src/index.js";
import {
  openVNextDatabase,
  SqliteApprovalRepository
} from "../../packages/store-sqlite/src/index.js";
import { FakeCodexAppServer } from "../support/fake-app-server.js";

const resources: Array<{ adapter: CodexAppServerAdapter; close(): void }> = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map(async ({ adapter, close }) => {
    await adapter.dispose();
    close();
  }));
});

describe("vNext approval bridge contract", () => {
  it("captures an AppServer request, resolves it, and persists the final server state", async () => {
    const server = new FakeCodexAppServer();
    const database = openVNextDatabase(":memory:");
    const repository = new SqliteApprovalRepository(database);
    const captured: string[] = [];
    const resolved: string[] = [];
    let approvalService!: ApprovalService;
    const adapter = new CodexAppServerAdapter({
      endpointProvider: staticEndpointProvider(),
      createWebSocket: () => server.connect() as never,
      requestTimeoutMs: 1_000,
      onApprovalRequest: async (request) => { await approvalService.capture(request); },
      onServerRequestResolved: async (input) => { await approvalService.markServerResolved(input); }
    });
    resources.push({ adapter, close: () => database.close() });
    approvalService = new ApprovalService({
      repository,
      bridge: {
        respond: (input) => adapter.resolveApprovalRequest(input)
      },
      nextId: () => "approval-contract-1",
      onCaptured: (request) => { captured.push(request.approvalId); },
      onResolved: (request) => { resolved.push(request.status); }
    });

    await adapter.health();
    server.socket.request(71, "item/commandExecution/requestApproval", {
      threadId: "thread-approval",
      turnId: "turn-approval",
      itemId: "item-approval",
      reason: "run the verification suite",
      command: "pnpm test",
      cwd: "/workspace"
    });
    await flushAsyncEvents();

    const pending = await approvalService.list({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      approvalId: "approval-contract-1",
      appServerRequestId: 71,
      kind: "command_execution",
      status: "pending"
    });
    expect(captured).toEqual(["approval-contract-1"]);

    await expect(approvalService.resolve({ approvalId: "approval-contract-1", resolution: "approve" }))
      .resolves.toMatchObject({ status: "resolving", resolution: "approve" });
    expect(server.socket.responses).toContainEqual({
      jsonrpc: "2.0",
      id: 71,
      result: { decision: "accept" }
    });

    server.socket.notify("serverRequest/resolved", {
      threadId: "thread-approval",
      requestId: 71
    });
    await flushAsyncEvents();

    await expect(approvalService.get("approval-contract-1")).resolves.toMatchObject({
      status: "approved",
      resolution: "approve",
      resolvedAt: expect.any(String)
    });
    expect(resolved).toEqual(["approved"]);
  });
});

function staticEndpointProvider() {
  return {
    async resolve() {
      return { url: "ws://127.0.0.1:1", managed: false };
    },
    dispose() {}
  };
}

async function flushAsyncEvents(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
