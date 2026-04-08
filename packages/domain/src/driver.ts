export type DriverBinding = {
  sessionKey: string;
  codexThreadRef: string | null;
};

export class DesktopDriverError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "app_not_ready"
      | "session_not_found"
      | "input_not_found"
      | "reply_timeout"
      | "reply_parse_failed"
  ) {
    super(message);
  }
}
