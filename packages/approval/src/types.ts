export type ApprovalKind = "command_execution" | "file_change";
export type ApprovalStatus = "pending" | "resolving" | "approved" | "declined" | "cancelled";
export type ApprovalResolution = "approve" | "decline";
export type AppServerRequestId = string | number;

export type ApprovalRequest = {
  approvalId: string;
  requestKey: string;
  appServerRequestId: AppServerRequestId;
  kind: ApprovalKind;
  method: "item/commandExecution/requestApproval" | "item/fileChange/requestApproval";
  threadId: string;
  turnId: string;
  itemId: string;
  reason: string | null;
  command: string | null;
  cwd: string | null;
  grantRoot: string | null;
  params: Record<string, unknown>;
  status: ApprovalStatus;
  resolution: ApprovalResolution | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
};

export type CapturedApprovalRequest = Pick<
  ApprovalRequest,
  "appServerRequestId" | "method" | "threadId" | "turnId" | "itemId" | "reason" | "command" | "cwd" | "grantRoot" | "params"
>;
