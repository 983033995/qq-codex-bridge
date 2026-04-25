import type { MediaArtifact, OutboundDraft } from "../../domain/src/message.js";

export function formatWeixinOutboundDraft(draft: OutboundDraft): OutboundDraft {
  const formattedText = formatWeixinOutboundText(draft.text, draft.mediaArtifacts ?? []);
  if (formattedText === draft.text) {
    return draft;
  }

  return {
    ...draft,
    text: formattedText
  };
}

export function formatWeixinOutboundText(text: string, mediaArtifacts: MediaArtifact[]): string {
  if (!text) {
    return text;
  }

  const strippedMediaBlocks = text.replace(/<qqmedia>[\s\S]*?<\/qqmedia>/g, "");
  const hasMediaArtifacts = mediaArtifacts.length > 0;
  const pathSet = new Set(
    mediaArtifacts.flatMap((artifact) =>
      [artifact.localPath, artifact.sourceUrl].filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0
      )
    )
  );

  const normalizedLines = strippedMediaBlocks
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return false;
      }

      if (trimmed.includes("<qqmedia>") || trimmed.includes("</qqmedia>")) {
        return false;
      }

      if (pathSet.has(stripWrapping(trimmed))) {
        return false;
      }

      if (containsOnlyArtifactPath(trimmed, pathSet)) {
        return false;
      }

      if (hasMediaArtifacts && shouldDropInternalBridgeLine(trimmed)) {
        return false;
      }

      return true;
    });

  return normalizedLines.join("\n").trim();
}

function containsOnlyArtifactPath(line: string, paths: Set<string>): boolean {
  const normalized = stripWrapping(line);
  return Array.from(paths).some((path) => normalized === stripWrapping(path));
}

function stripWrapping(value: string): string {
  return value.replace(/^[-*]\s*/, "").replace(/^`+/, "").replace(/`+$/, "").trim();
}

function shouldDropInternalBridgeLine(line: string): boolean {
  return (
    line.includes("QQBot 桥接程序收到你上传附件后") ||
    line.includes("临时落盘的运行目录路径") ||
    line.includes("这里看到的是相对路径") ||
    line.includes("runtime/media/") ||
    line.includes("/Volumes/") ||
    /^[A-Za-z]:[\\/]/.test(line)
  );
}
