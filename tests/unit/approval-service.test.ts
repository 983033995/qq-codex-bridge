import { describe, expect, it, vi } from "vitest";
import {
  ApprovalService,
  type ApprovalRepository,
  type ApprovalRequest,
  type AppServerRequestId,
  type CapturedApprovalRequest
} from "../../packages/approval/src/index.js";
import {
  openVNextDatabase,
  SqliteApprovalRepository
} from "../../packages/store-sqlite/src/index.js";

describe("ApprovalService", () => {
  it("captures idempotently and completes the AppServer resolution state machine", async () => {
    const repository = new MemoryApprovalRepository();
    const respond = vi.fn(async () => undefined);
    const onCaptured = vi.fn();
    const onResolved = vi.fn();
    const service = new ApprovalService({
      repository,
      bridge: { respond },
      nextId: () => "approval-1",
      now: sequenceClock(),
      onCaptured,
      onResolved
    });

    const captured = await service.capture(capturedRequest());
    await expect(service.capture(capturedRequest())).resolves.toEqual(captured);
    expect(onCaptured).toHaveBeenCalledTimes(1);

    const resolving = await service.resolve({
      approvalId: captured.approvalId,
      resolution: "approve"
    });
    expect(resolving).toMatchObject({ status: "resolving", resolution: "approve" });
    expect(respond).toHaveBeenCalledWith({ requestId: 42, resolution: "approve" });

    const resolved = await service.markServerResolved({ threadId: "thread-1", requestId: 42 });
    expect(resolved).toMatchObject({ status: "approved", resolution: "approve" });
    expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ status: "approved" }));
    await expect(service.resolve({ approvalId: captured.approvalId, resolution: "approve" }))
      .resolves.toMatchObject({ status: "approved" });
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("requires an explicit id when a thread has multiple pending requests", async () => {
    const repository = new MemoryApprovalRepository();
    let id = 0;
    const service = new ApprovalService({
      repository,
      bridge: { respond: async () => undefined },
      nextId: () => `approval-${++id}`
    });
    await service.capture(capturedRequest({ itemId: "item-1", appServerRequestId: 1 }));
    await service.capture(capturedRequest({ itemId: "item-2", appServerRequestId: 2 }));

    await expect(service.resolve({ threadId: "thread-1", resolution: "decline" }))
      .rejects.toThrow("多个待审批请求");
  });

  it("restores pending state and records the bridge error when responding fails", async () => {
    const repository = new MemoryApprovalRepository();
    const service = new ApprovalService({
      repository,
      bridge: { respond: async () => { throw new Error("socket closed"); } },
      nextId: () => "approval-1"
    });
    await service.capture(capturedRequest());

    await expect(service.resolve({ approvalId: "approval-1", resolution: "approve" }))
      .rejects.toThrow("socket closed");
    await expect(service.get("approval-1")).resolves.toMatchObject({
      status: "pending",
      resolution: null,
      error: "socket closed"
    });
  });
});

describe("SqliteApprovalRepository", () => {
  it("round-trips request ids and filters pending requests by thread", async () => {
    const db = openVNextDatabase(":memory:");
    try {
      const repository = new SqliteApprovalRepository(db);
      const service = new ApprovalService({
        repository,
        bridge: { respond: async () => undefined },
        nextId: () => "approval-sqlite"
      });
      const captured = await service.capture(capturedRequest({ appServerRequestId: "rpc-42" }));

      await expect(repository.get(captured.approvalId)).resolves.toEqual(captured);
      await expect(repository.list({ status: "pending", threadId: "thread-1" }))
        .resolves.toEqual([captured]);
      await expect(repository.findUnresolvedByServerRequest("thread-1", "rpc-42"))
        .resolves.toEqual(captured);
    } finally {
      db.close();
    }
  });
});

class MemoryApprovalRepository implements ApprovalRepository {
  private readonly requests = new Map<string, ApprovalRequest>();

  async get(approvalId: string): Promise<ApprovalRequest | null> {
    return clone(this.requests.get(approvalId) ?? null);
  }

  async findByRequestKey(requestKey: string): Promise<ApprovalRequest | null> {
    return clone([...this.requests.values()].find((request) => request.requestKey === requestKey) ?? null);
  }

  async findUnresolvedByServerRequest(
    threadId: string,
    requestId: AppServerRequestId
  ): Promise<ApprovalRequest | null> {
    return clone([...this.requests.values()].find((request) =>
      request.threadId === threadId
      && request.appServerRequestId === requestId
      && (request.status === "pending" || request.status === "resolving")) ?? null);
  }

  async list(input: Parameters<ApprovalRepository["list"]>[0] = {}): Promise<ApprovalRequest[]> {
    return [...this.requests.values()]
      .filter((request) => !input?.status || request.status === input.status)
      .filter((request) => !input?.threadId || request.threadId === input.threadId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.approvalId.localeCompare(left.approvalId))
      .slice(0, input?.limit ?? 100)
      .map((request) => clone(request));
  }

  async save(request: ApprovalRequest): Promise<void> {
    this.requests.set(request.approvalId, clone(request));
  }
}

function capturedRequest(overrides: Partial<CapturedApprovalRequest> = {}): CapturedApprovalRequest {
  return {
    appServerRequestId: 42,
    method: "item/commandExecution/requestApproval",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    reason: "run tests",
    command: "pnpm test",
    cwd: "/workspace",
    grantRoot: null,
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" },
    ...overrides
  };
}

function sequenceClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 13, 0, 0, tick++));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
