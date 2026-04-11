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
  ) {
    super(message);
  }
}
