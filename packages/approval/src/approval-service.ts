import type {
  ApprovalRequest,
  ApprovalResolution,
  ApprovalStatus,
  AppServerRequestId,
  CapturedApprovalRequest
} from "./types.js";

export interface ApprovalRepository {
  get(approvalId: string): Promise<ApprovalRequest | null>;
  findByRequestKey(requestKey: string): Promise<ApprovalRequest | null>;
  findUnresolvedByServerRequest(threadId: string, requestId: AppServerRequestId): Promise<ApprovalRequest | null>;
  list(input?: { status?: ApprovalStatus; threadId?: string; limit?: number }): Promise<ApprovalRequest[]>;
  save(request: ApprovalRequest): Promise<void>;
}

export type ApprovalBridge = {
  respond(input: {
    requestId: AppServerRequestId;
    resolution: ApprovalResolution;
  }): Promise<void>;
};

export class ApprovalService {
  private readonly now: () => Date;

  constructor(private readonly options: {
    repository: ApprovalRepository;
    bridge: ApprovalBridge;
    nextId(): string;
    now?: () => Date;
    onCaptured?(request: ApprovalRequest): Promise<void> | void;
    onResolved?(request: ApprovalRequest): Promise<void> | void;
  }) {
    this.now = options.now ?? (() => new Date());
  }

  list(input: { status?: ApprovalStatus; threadId?: string; limit?: number } = {}): Promise<ApprovalRequest[]> {
    return this.options.repository.list(input);
  }

  async get(approvalId: string): Promise<ApprovalRequest> {
    const request = await this.options.repository.get(required(approvalId, "approvalId"));
    if (!request) throw new Error(`Approval '${approvalId}' was not found`);
    return request;
  }

  async capture(input: CapturedApprovalRequest): Promise<ApprovalRequest> {
    const requestKey = approvalRequestKey(input);
    const existing = await this.options.repository.findByRequestKey(requestKey);
    if (existing) return existing;
    const at = this.now().toISOString();
    const request: ApprovalRequest = {
      approvalId: this.options.nextId(),
      requestKey,
      appServerRequestId: input.appServerRequestId,
      kind: input.method === "item/commandExecution/requestApproval" ? "command_execution" : "file_change",
      method: input.method,
      threadId: required(input.threadId, "threadId"),
      turnId: required(input.turnId, "turnId"),
      itemId: required(input.itemId, "itemId"),
      reason: input.reason,
      command: input.command,
      cwd: input.cwd,
      grantRoot: input.grantRoot,
      params: input.params,
      status: "pending",
      resolution: null,
      error: null,
      createdAt: at,
      updatedAt: at,
      resolvedAt: null
    };
    await this.options.repository.save(request);
    await this.options.onCaptured?.(request);
    return request;
  }

  async resolve(input: {
    resolution: ApprovalResolution;
    approvalId?: string;
    threadId?: string;
  }): Promise<ApprovalRequest> {
    const request = await this.selectPending(input);
    if (request.status !== "pending") return request;
    const resolving: ApprovalRequest = {
      ...request,
      status: "resolving",
      resolution: input.resolution,
      error: null,
      updatedAt: this.now().toISOString()
    };
    await this.options.repository.save(resolving);
    try {
      await this.options.bridge.respond({
        requestId: resolving.appServerRequestId,
        resolution: input.resolution
      });
      return resolving;
    } catch (error) {
      const failed: ApprovalRequest = {
        ...resolving,
        status: "pending",
        resolution: null,
        error: errorMessage(error),
        updatedAt: this.now().toISOString()
      };
      await this.options.repository.save(failed);
      throw error;
    }
  }

  async markServerResolved(input: {
    threadId: string;
    requestId: AppServerRequestId;
  }): Promise<ApprovalRequest | null> {
    const request = await this.options.repository.findUnresolvedByServerRequest(input.threadId, input.requestId);
    if (!request) return null;
    const at = this.now().toISOString();
    const resolved: ApprovalRequest = {
      ...request,
      status: request.resolution === "approve"
        ? "approved"
        : request.resolution === "decline"
          ? "declined"
          : "cancelled",
      updatedAt: at,
      resolvedAt: at,
      error: null
    };
    await this.options.repository.save(resolved);
    await this.options.onResolved?.(resolved);
    return resolved;
  }

  private async selectPending(input: {
    resolution: ApprovalResolution;
    approvalId?: string;
    threadId?: string;
  }): Promise<ApprovalRequest> {
    if (input.approvalId) return this.get(input.approvalId);
    const pending = await this.options.repository.list({
      status: "pending",
      ...(input.threadId ? { threadId: input.threadId } : {}),
      limit: 2
    });
    if (pending.length === 0) {
      throw new Error(input.threadId
        ? "当前会话没有待审批请求"
        : "当前没有待审批请求");
    }
    if (pending.length > 1) {
      throw new Error("有多个待审批请求，请明确指定 approvalId");
    }
    return pending[0]!;
  }
}

export function approvalRequestKey(input: Pick<
  CapturedApprovalRequest,
  "threadId" | "turnId" | "itemId" | "method" | "appServerRequestId"
>): string {
  return [input.threadId, input.turnId, input.itemId, input.method, typeof input.appServerRequestId, String(input.appServerRequestId)].join("\0");
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
