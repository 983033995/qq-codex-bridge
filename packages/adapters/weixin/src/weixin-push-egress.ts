import fs from "node:fs";
import path from "node:path";
import { MediaArtifactKind, type MediaArtifact } from "../../../domain/src/message.js";
import type { PushEgressPort, PushMediaInput } from "../../../ports/src/push.js";
import type { WeixinHttpClient } from "./weixin-http-client.js";

export class WeixinPushEgress implements PushEgressPort {
  constructor(private readonly client: Pick<WeixinHttpClient, "sendMessage">) {}

  async send(input: Parameters<PushEgressPort["send"]>[0]): ReturnType<PushEgressPort["send"]> {
    try {
      const mediaArtifacts = input.resolvedMediaPaths.map((mediaPath, index) =>
        buildArtifact(mediaPath, input.payload.message.media[index])
      );
      const providerMessageId = await this.client.sendMessage({
        accountKey: input.target.accountKey,
        peerId: input.target.providerTargetId,
        chatType: input.target.targetType === "user" ? "c2c" : "group",
        content: input.payload.message.text,
        ...(mediaArtifacts.length > 0 ? { mediaArtifacts } : {})
      });
      return { ok: true, providerMessageId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = Number(/^Weixin message send failed: (\d{3})\b/.exec(message)?.[1]);
      const rateLimited = status === 429;
      const permanent = status >= 400 && status < 500 && !rateLimited;
      return {
        ok: false,
        retryable: !permanent,
        code: rateLimited ? "rate_limited" : permanent ? "permanent_failure" : "temporary_failure",
        message
      };
    }
  }
}

function buildArtifact(mediaPath: string, media: PushMediaInput | undefined): MediaArtifact {
  const stat = fs.statSync(mediaPath);
  return {
    kind: mapKind(media?.type),
    sourceUrl: "",
    localPath: mediaPath,
    mimeType: mimeType(mediaPath),
    fileSize: stat.size,
    originalName: path.basename(mediaPath)
  };
}

function mapKind(type: PushMediaInput["type"] | undefined): MediaArtifactKind {
  switch (type) {
    case "image": return MediaArtifactKind.Image;
    case "audio": return MediaArtifactKind.Audio;
    case "video": return MediaArtifactKind.Video;
    default: return MediaArtifactKind.File;
  }
}

function mimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".mp4": return "video/mp4";
    default: return "application/octet-stream";
  }
}
