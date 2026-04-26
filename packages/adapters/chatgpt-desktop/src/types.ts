export type ChatgptDesktopTaskMode = "text" | "image";

export type ChatgptDesktopRunInput = {
  sessionKey?: string;
  threadRef?: string | null;
  mode: ChatgptDesktopTaskMode;
  prompt: string;
  attachmentPaths?: string[];
  timeoutMs?: number;
};

export type ChatgptDesktopMedia = {
  kind: "image";
  localPath: string;
  mimeType: string;
  fileSize: number;
  originalName: string;
};

export type ChatgptDesktopRunResult =
  | {
      ok: true;
      provider: "chatgpt-desktop";
      threadRef: string | null;
      turnId: string;
      text: string;
      media: ChatgptDesktopMedia[];
      elapsedMs: number;
    }
  | {
      ok: false;
      provider: "chatgpt-desktop";
      errorCode:
        | "app_not_ready"
        | "accessibility_denied"
        | "input_not_found"
        | "send_failed"
        | "reply_timeout"
        | "reply_parse_failed"
        | "image_not_found";
      message: string;
    };

export type ChatgptHealthResult = {
  ok: boolean;
  appRunning: boolean;
  accessibility: boolean;
  cacheDirFound: boolean;
  frontmost: boolean;
};
