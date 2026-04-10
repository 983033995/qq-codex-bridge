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
  const mediaArtifacts = message.mediaArtifacts ?? [];
  const voiceTranscriptSection = buildVoiceTranscriptSection(mediaArtifacts);
  const visibleSections = [baseText, voiceTranscriptSection].filter(Boolean);
  const sections = [
    visibleSections.length > 0 ? visibleSections.join("\n\n") : inferAttachmentOnlyPlaceholder(message)
  ];
  const hiddenContexts: string[] = [];
  const attachmentContextArtifacts = mediaArtifacts.filter(shouldKeepAttachmentContext);

  if (attachmentContextArtifacts.length > 0) {
    hiddenContexts.push(buildHiddenAttachmentContext(attachmentContextArtifacts));
  }

  if ((options.includeSkillContext ?? true) && shouldInjectQqbotSkillContext(message)) {
    hiddenContexts.push(wrapHiddenContext("QQBOT_RUNTIME_CONTEXT", buildQqbotSkillContext(message)));
  }

  if (hiddenContexts.length > 0) {
    sections.push("", ...hiddenContexts);
  }

  return sections.join("\n");
}

function buildHiddenAttachmentContext(artifacts: MediaArtifact[]): string {
  const lines = ["QQBOT_ATTACHMENTS"];

  for (const [index, artifact] of artifacts.entries()) {
    lines.push(`${index + 1}. ${renderArtifactLabel(artifact)}：${artifact.originalName}`);
    lines.push(`path=${artifact.localPath}`);
    lines.push(`mime=${artifact.mimeType}`);
    lines.push(`size=${artifact.fileSize}`);

    const extractedText = artifact.extractedText?.trim();
    if (extractedText && !isGenericAttachmentText(extractedText, artifact)) {
      lines.push(`extracted=${extractedText}`);
    }

    const transcript = artifact.transcript?.trim();
    if (transcript) {
      lines.push(`transcript=${transcript}`);
    }

    const transcriptSource = artifact.transcriptSource?.trim();
    if (transcriptSource) {
      lines.push(`transcriptSource=${transcriptSource}`);
    }
  }

  return wrapHiddenContext("QQBOT_ATTACHMENTS", lines.join("\n"));
}

function wrapHiddenContext(label: string, content: string): string {
  return [`<!-- ${label}`, content, "-->"].join("\n");
}

function inferAttachmentOnlyPlaceholder(message: InboundMessage): string {
  if (message.mediaArtifacts?.length) {
    const count = message.mediaArtifacts.length;
    return `（用户发送了 ${count} 个 QQ 附件）`;
  }

  return "(用户消息未包含文本)";
}

function buildVoiceTranscriptSection(artifacts: MediaArtifact[]): string {
  const voiceArtifacts = artifacts.filter(
    (artifact) => artifact.kind === "audio" && artifact.transcript?.trim()
  );

  if (voiceArtifacts.length === 0) {
    return "";
  }

  if (voiceArtifacts.length === 1) {
    return `[语音消息] ${voiceArtifacts[0].transcript!.trim()}`;
  }

  return voiceArtifacts
    .map((artifact, index) => `[语音${index + 1}] ${artifact.transcript!.trim()}`)
    .join("\n");
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

function shouldKeepAttachmentContext(artifact: MediaArtifact): boolean {
  if (artifact.kind === "audio" && artifact.transcript?.trim()) {
    return false;
  }

  return true;
}
