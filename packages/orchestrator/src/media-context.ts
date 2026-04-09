import type { InboundMessage, MediaArtifact } from "../../domain/src/message.js";
import {
  buildQqbotSkillContext,
  shouldInjectQqbotSkillContext
} from "./qqbot-skill-context.js";

export function buildCodexInboundText(
  message: InboundMessage,
  options: { includeSkillContext?: boolean } = {}
): string {
  const baseText = message.text.trim();
  const sections = [baseText || "(用户消息未包含文本)"];

  if (message.mediaArtifacts?.length) {
    sections.push("", "[QQ附件]");
    for (const [index, artifact] of message.mediaArtifacts.entries()) {
      sections.push(renderArtifact(index + 1, artifact));
    }
  }

  if ((options.includeSkillContext ?? true) && shouldInjectQqbotSkillContext(message)) {
    sections.push("", buildQqbotSkillContext(message));
  }

  return sections.join("\n");
}

function renderArtifact(index: number, artifact: MediaArtifact): string {
  const lines = [`${index}. ${renderArtifactLabel(artifact)}：${artifact.originalName}`];

  if (artifact.kind === "image") {
    lines.push(`![${artifact.originalName}](${artifact.localPath})`);
  } else {
    lines.push(`[${artifact.originalName}](${artifact.localPath})`);
  }

  const extractedText = artifact.extractedText?.trim();
  if (extractedText && !isGenericAttachmentText(extractedText, artifact)) {
    lines.push(`说明：${extractedText}`);
  }

  return lines.join("\n");
}

function renderArtifactLabel(artifact: MediaArtifact): string {
  switch (artifact.kind) {
    case "image":
      return "图片";
    case "audio":
      return "音频";
    case "video":
      return "视频";
    case "file":
      return "文件";
    default:
      return "附件";
  }
}

function isGenericAttachmentText(text: string, artifact: MediaArtifact): boolean {
  const genericPrefixes = ["图片附件：", "语音附件：", "视频附件：", "文件附件："];
  return genericPrefixes.some((prefix) => text === `${prefix}${artifact.originalName}`);
}
