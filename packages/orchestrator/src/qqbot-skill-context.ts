import type { InboundMessage } from "../../domain/src/message.js";

export function buildQqbotSkillContext(message: InboundMessage): string {
  const lines = [
    "【QQBot桥接技能】",
    `- 当前会话类型：${message.chatType === "group" ? "QQ 群聊" : "QQ 私聊"}`,
    "- 这是通过 QQBot 桥接过来的会话，你可以直接为 QQ 用户准备可发送内容。",
    "- 如果要发送图片、语音、视频、文件，必须使用 <qqmedia>绝对路径或URL</qqmedia>。",
    "- 多个媒体请输出多个 <qqmedia> 标签，文本说明写在标签前后即可。",
    "- 不要只说“已发送图片”“测试音频”，要直接输出可执行的媒体标签。",
    "- 用户发来的附件路径已经写在【附件】里，可以直接复用这些绝对路径回发。",
    "- 文件大小限制：图片最大 30MB，语音最大 20MB，视频与文件最大 100MB。"
  ];

  return lines.join("\n");
}

export function shouldInjectQqbotSkillContext(message: InboundMessage): boolean {
  return message.accountKey.startsWith("qqbot:");
}
