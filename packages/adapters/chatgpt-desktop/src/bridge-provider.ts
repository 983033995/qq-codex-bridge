import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { InboundMessage, MediaArtifact, OutboundDraft } from "../../../domain/src/message.js";
import { MediaArtifactKind } from "../../../domain/src/message.js";
import type { ConversationProviderPort, ConversationRunOptions } from "../../../ports/src/conversation.js";
import { ChatgptDesktopDriver } from "./driver.js";
import type { ChatgptDesktopRunInput } from "./types.js";

const DEFAULT_OUT_DIR = "runtime/media/chatgpt";

const CHINESE_IMAGE_KEYWORDS = /(画|绘|生成图|生图|作图|图片|照片|摄影|插图|海报|壁纸|合影|全家福)/;
const ENGLISH_IMAGE_KEYWORDS =
  /\b(draw|paint|generate\s+image|create\s+image|make\s+image|image\s+of|picture\s+of|photo|photograph|illustration|poster|wallpaper|dalle|dall-e)\b/i;

export function detectMode(text: string): "text" | "image" {
  return CHINESE_IMAGE_KEYWORDS.test(text) || ENGLISH_IMAGE_KEYWORDS.test(text) ? "image" : "text";
}

function isImageArtifact(artifact: MediaArtifact): boolean {
  return artifact.kind === MediaArtifactKind.Image || artifact.mimeType.startsWith("image/");
}

function buildPrompt(message: InboundMessage, imageArtifacts: MediaArtifact[]): string {
  const text = message.text.trim();
  if (text) {
    return text;
  }
  if (imageArtifacts.length > 0) {
    return "请分析这张图片，并根据图片内容回复我。";
  }
  return message.text;
}

export class ChatgptDesktopProvider implements ConversationProviderPort {
  private readonly driver: ChatgptDesktopDriver;
  private readonly outDir: string;

  constructor(opts: { outDir?: string } = {}) {
    this.outDir = opts.outDir ?? DEFAULT_OUT_DIR;
    this.driver = new ChatgptDesktopDriver({ destDir: this.outDir });
  }

  get desktopDriver(): ChatgptDesktopDriver {
    return this.driver;
  }

  async runTurn(
    message: InboundMessage,
    options?: ConversationRunOptions
  ): Promise<OutboundDraft[]> {
    const imageArtifacts = (message.mediaArtifacts ?? []).filter(isImageArtifact);
    const prompt = buildPrompt(message, imageArtifacts);
    const mode = detectMode(prompt);
    const input: ChatgptDesktopRunInput = {
      sessionKey: message.sessionKey,
      mode,
      prompt,
      attachmentPaths: imageArtifacts.map((artifact) => artifact.localPath).filter(Boolean),
      timeoutMs: mode === "image" ? 180_000 : 120_000
    };

    const result = await this.driver.run(input);

    if (!result.ok) {
      const errorDraft: OutboundDraft = {
        draftId: randomUUID(),
        turnId: undefined,
        sessionKey: message.sessionKey,
        text: `[ChatGPT Desktop 错误] ${result.errorCode}: ${result.message}`,
        createdAt: new Date().toISOString(),
        replyToMessageId: message.messageId
      };
      if (options?.onDraft) {
        await options.onDraft(errorDraft);
      }
      return [errorDraft];
    }

    const mediaArtifacts = result.media.map((m) => ({
      kind: MediaArtifactKind.Image,
      sourceUrl: pathToFileURL(m.localPath).href,
      localPath: m.localPath,
      mimeType: m.mimeType,
      fileSize: m.fileSize,
      originalName: m.originalName
    }));

    const draft: OutboundDraft = {
      draftId: randomUUID(),
      turnId: result.turnId,
      sessionKey: message.sessionKey,
      text: result.text,
      mediaArtifacts: mediaArtifacts.length > 0 ? mediaArtifacts : undefined,
      createdAt: new Date().toISOString(),
      replyToMessageId: message.messageId
    };

    if (options?.onDraft) {
      await options.onDraft(draft);
    }

    return [draft];
  }
}
