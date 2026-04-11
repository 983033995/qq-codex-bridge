import type { MediaArtifact, OutboundDraft } from "../../domain/src/message.js";

export function formatQqOutboundDraft(draft: OutboundDraft): OutboundDraft {
  const formattedText = formatQqOutboundText(draft.text, draft.mediaArtifacts ?? []);
  if (formattedText === draft.text) {
    return draft;
  }

  return {
    ...draft,
    text: formattedText
  };
}

export function formatQqOutboundText(text: string, mediaArtifacts: MediaArtifact[]): string {
  const hasMediaArtifacts = mediaArtifacts.length > 0;
  const pathSet = new Set(
    mediaArtifacts.flatMap((artifact) =>
      [artifact.localPath, artifact.sourceUrl].filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0
      )
    )
  );

  const lines = text.split("\n");
  const normalizedLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      normalizedLines.push("");
      continue;
    }

    if (pathSet.has(stripWrapping(trimmed))) {
      continue;
    }

    if (containsOnlyArtifactPath(trimmed, pathSet)) {
      continue;
    }

    if (hasMediaArtifacts && shouldDropInternalBridgeLine(trimmed)) {
      continue;
    }

    normalizedLines.push(line);
  }

  return normalizedLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
    line.includes("/Volumes/")
  );
}
