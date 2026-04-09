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

    normalizedLines.push(trimmed);
  }

  return collapseMarkdownTables(normalizedLines)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function collapseMarkdownTables(lines: string[]): string[] {
  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!looksLikeTableLine(lines[index])) {
      output.push(lines[index]);
      index += 1;
      continue;
    }

    const tableLines: string[] = [];
    while (index < lines.length && looksLikeTableLine(lines[index])) {
      tableLines.push(lines[index]);
      index += 1;
    }

    const collapsed = renderTableAsBullets(tableLines);
    if (collapsed.length > 0) {
      output.push(...collapsed);
      continue;
    }

    output.push(...tableLines);
  }

  return output;
}

function renderTableAsBullets(lines: string[]): string[] {
  const contentLines = lines.filter((line) => {
    const normalized = line.replace(/\|/g, "").trim();
    return !/^[:\-\s]+$/.test(normalized);
  });
  if (contentLines.length < 2) {
    return lines;
  }

  const headers = splitTableCells(contentLines[0]);
  if (headers.length === 0) {
    return lines;
  }

  return contentLines.slice(1).map((line) => {
    const cells = splitTableCells(line);
    const parts = headers
      .map((header, idx) => {
        const value = cells[idx]?.trim();
        return value ? `${header}：${value}` : null;
      })
      .filter((value): value is string => Boolean(value));
    return `- ${parts.join("；")}`;
  });
}

function splitTableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean);
}

function looksLikeTableLine(line: string): boolean {
  return line.includes("|");
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
