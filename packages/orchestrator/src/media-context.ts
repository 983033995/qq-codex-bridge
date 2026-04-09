import type { InboundMessage, MediaArtifact } from "../../domain/src/message.js";
import {
  buildQqbotSkillContext,
  shouldInjectQqbotSkillContext
} from "./qqbot-skill-context.js";

export function buildCodexInboundText(message: InboundMessage): string {
  const baseText = message.text.trim();
  const sections = [baseText || "(用户消息未包含文本)"];

  if (message.mediaArtifacts?.length) {
    sections.push("", "【附件】");
    for (const [index, artifact] of message.mediaArtifacts.entries()) {
      sections.push(renderArtifact(index + 1, artifact));
    }
  }

  if (shouldInjectQqbotSkillContext(message)) {
    sections.push("", buildQqbotSkillContext(message));
  }

  return sections.join("\n");
}

function renderArtifact(index: number, artifact: MediaArtifact): string {
  const lines = [
    `附件 ${index}`,
    `- 类型：${artifact.kind}`,
    `- 文件：${artifact.originalName}`,
    `- 路径：${artifact.localPath}`,
    `- MIME：${artifact.mimeType}`,
    `- 大小：${artifact.fileSize} bytes`
  ];

  if (artifact.extractedText?.trim()) {
    lines.push(`- 提取文本：${artifact.extractedText.trim()}`);
  }

  return lines.join("\n");
}
