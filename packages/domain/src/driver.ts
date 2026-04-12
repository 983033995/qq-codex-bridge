export type DriverBinding = {
  sessionKey: string;
  codexThreadRef: string | null;
};

export type CodexThreadSummary = {
  index: number;
  title: string;
  projectName: string | null;
  relativeTime: string | null;
  isCurrent: boolean;
  threadRef: string;
};

export type CodexControlState = {
  model: string | null;
  reasoningEffort: string | null;
  workspace: string | null;
  branch: string | null;
  permissionMode: string | null;
  quotaSummary: string | null;
};

export class DesktopDriverError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "app_not_ready"
      | "session_not_found"
      | "input_not_found"
      | "submit_failed"
      | "reply_timeout"
      | "reply_parse_failed"
      | "control_not_found"
  ) {
    super(message);
  }
}
