import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  checkAccessibility,
  clickChatByTitle,
  clickNewChat,
  ensureAppVisible,
  getCurrentWindowTitle,
  healthCheck,
  listRecentChats,
  sendMessage
} from "./ax-client.js";
import type { ChatgptThread } from "./ax-client.js";
import { diffCache, isCacheDirReachable, saveToDest, snapshotCache, waitForCacheImages } from "./image-cache.js";
import { ChatgptSessionRegistry } from "./session-registry.js";
import type {
  ChatgptDesktopRunInput,
  ChatgptDesktopRunResult,
  ChatgptHealthResult,
  ChatgptDesktopMedia
} from "./types.js";

const DEFAULT_DEST_DIR = join(process.cwd(), "runtime", "media", "chatgpt");
const DEFAULT_TEXT_TIMEOUT_MS = 60_000;
const DEFAULT_IMAGE_TIMEOUT_MS = 180_000;

export type ChatgptDesktopDriverOptions = {
  destDir?: string;
  registryPath?: string;
};

export class ChatgptDesktopDriver {
  private readonly registry: ChatgptSessionRegistry;
  private readonly destDir: string;

  constructor(opts: ChatgptDesktopDriverOptions = {}) {
    this.registry = new ChatgptSessionRegistry(opts.registryPath);
    this.destDir = opts.destDir ?? DEFAULT_DEST_DIR;
  }

  async health(): Promise<ChatgptHealthResult> {
    const { appRunning, accessibility, frontmost } = healthCheck();
    const cacheDirFound = isCacheDirReachable();
    return {
      ok: appRunning && accessibility && cacheDirFound,
      appRunning,
      accessibility,
      cacheDirFound,
      frontmost
    };
  }

  listChats(maxCount = 20): ChatgptThread[] {
    return listRecentChats(maxCount);
  }

  switchToChat(title: string): boolean {
    return clickChatByTitle(title);
  }

  markSwitched(sessionKey: string, threadTitle?: string): void {
    // signal that user manually switched to a thread — next run() should skip clickNewChat
    this.registry.set(sessionKey, threadTitle ?? "__switched__", null);
  }

  newChat(sessionKey?: string): void {
    if (sessionKey) {
      this.registry.delete(sessionKey);
    }
    clickNewChat();
  }

  getSessionThreadRef(sessionKey: string): string | null {
    return this.registry.get(sessionKey)?.threadRef ?? null;
  }

  getCurrentThreadTitle(): string | null {
    return getCurrentWindowTitle();
  }

  async run(input: ChatgptDesktopRunInput): Promise<ChatgptDesktopRunResult> {
    const t0 = Date.now();
    const turnId = randomUUID();

    if (!checkAccessibility()) {
      return {
        ok: false,
        provider: "chatgpt-desktop",
        errorCode: "accessibility_denied",
        message: "Accessibility permission not granted. Enable in System Settings > Privacy > Accessibility."
      };
    }

    try {
      ensureAppVisible();
    } catch (err) {
      return {
        ok: false,
        provider: "chatgpt-desktop",
        errorCode: "app_not_ready",
        message: err instanceof Error ? err.message : String(err)
      };
    }

    // decide whether to open a new thread
    const existing = input.sessionKey ? this.registry.get(input.sessionKey) : null;
    // skip clickNewChat if: registry has an entry (continuing thread) OR user manually switched ("__switched__" sentinel)
    const needNewThread = !existing;
    if (needNewThread) {
      try {
        clickNewChat();
      } catch {
        // non-fatal: may already be on a fresh thread
      }
    }

    const beforeCache = await snapshotCache();

    const timeoutMs = input.timeoutMs ?? (
      input.mode === "image" ? DEFAULT_IMAGE_TIMEOUT_MS : DEFAULT_TEXT_TIMEOUT_MS
    );

    const { confirmed, completed, elapsedMs, replyTexts } = sendMessage(input.prompt, {
      attachmentPaths: input.attachmentPaths,
      confirmTimeoutMs: input.attachmentPaths?.length ? 20_000 : 8_000,
      completionTimeoutMs: timeoutMs
    });

    if (!confirmed) {
      return {
        ok: false,
        provider: "chatgpt-desktop",
        errorCode: "send_failed",
        message: "Message was sent but 'Stop generating' button never appeared — ChatGPT may not have accepted the input."
      };
    }

    if (!completed) {
      return {
        ok: false,
        provider: "chatgpt-desktop",
        errorCode: "reply_timeout",
        message: `Timed out waiting for ChatGPT Desktop reply after ${timeoutMs}ms`
      };
    }

    // collect window title for session registry; use as threadRef so we can navigate back
    const windowTitle = getCurrentWindowTitle();
    if (input.sessionKey) {
      this.registry.set(input.sessionKey, windowTitle ?? existing?.threadRef ?? null, windowTitle);
    }

    // collect text reply (replyTexts already diffed inside Swift process)
    const replyText = replyTexts
      .filter((t: string) => t.length > 0)
      .join("\n")
      .trim();

    // collect images (for image mode, or if images appeared in text mode)
    const media: ChatgptDesktopMedia[] = [];
    const cacheImages = input.mode === "image"
      ? await waitForCacheImages(beforeCache, { timeoutMs: 45_000, intervalMs: 1_000 })
      : await diffCache(beforeCache);
    const newCacheFiles = input.mode === "image" ? cacheImages.slice(-1) : cacheImages;
    if (newCacheFiles.length > 0) {
      const prefix = `chatgpt-${turnId.slice(0, 8)}`;
      const saved = await saveToDest(newCacheFiles, this.destDir, prefix);
      for (const s of saved) {
        media.push({
          kind: "image",
          localPath: s.localPath,
          mimeType: s.mimeType,
          fileSize: s.fileSize,
          originalName: s.originalName
        });
      }
    }

    if (input.mode === "image" && media.length === 0) {
      return {
        ok: false,
        provider: "chatgpt-desktop",
        errorCode: "image_not_found",
        message: "No new image found in Kingfisher cache after generation completed."
      };
    }

    if (!replyText && media.length === 0) {
      return {
        ok: false,
        provider: "chatgpt-desktop",
        errorCode: "reply_parse_failed",
        message: "Reply completed but no text or images were collected from AX tree."
      };
    }

    return {
      ok: true,
      provider: "chatgpt-desktop",
      threadRef: existing?.threadRef ?? null,
      turnId,
      text: replyText,
      media,
      elapsedMs: Date.now() - t0
    };
  }
}
