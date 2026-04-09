import type { InboundMessage } from "../../domain/src/message.js";

export function buildQqbotSkillContext(message: InboundMessage): string {
  const lines = [
    "[QQBot运行说明]",
    `会话类型：${message.chatType === "group" ? "QQ 群聊" : "QQ 私聊"}`,
    "给 QQ 用户发图片、语音、视频、文件时，必须输出 <qqmedia>绝对路径或URL</qqmedia>。",
    "如果已经准备好本地文件，直接输出媒体标签，不要解释 bridge、runtime/media、相对路径或内部实现。",
    "多个媒体用多个 <qqmedia> 标签；正文只保留用户真正需要看的说明。",
    "大小限制：图片 30MB、语音 20MB、视频/文件 100MB。"
  ];

  return lines.join("\n");
}

export function shouldInjectQqbotSkillContext(message: InboundMessage): boolean {
  return message.accountKey.startsWith("qqbot:");
}
