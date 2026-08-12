export type PushChannel = "qq" | "weixin" | "feishu";
export type PushMessageFormat = "plain" | "markdown";

export type ChannelFormatGuide = {
  channel: PushChannel;
  recommendedFormat: PushMessageFormat;
  supportedFormats: PushMessageFormat[];
  summary: string;
  capabilities: string[];
  limitations: string[];
  writingTips: string[];
  mediaNotes: string;
};

type PublicTargetLike = {
  alias: string;
  channel: string;
  [key: string]: unknown;
};

export const CHANNEL_FORMAT_GUIDES: Record<PushChannel, ChannelFormatGuide> = {
  feishu: {
    channel: "feishu",
    recommendedFormat: "markdown",
    supportedFormats: ["plain", "markdown"],
    summary: "飞书：推荐 format=markdown（post + md，支持标题/列表/表格/代码块/链接）",
    capabilities: [
      "CommonMark 0.31 + GFM（标题、列表、加粗、代码块、表格、链接）",
      "format=markdown 时走飞书 post 富文本的 md 标签真实渲染",
      "format=plain 时走纯文本 msg_type=text",
      "图片/文件/视频通过 media[] 独立投递；iLink 不稳定支持主动语音条，audio 会作为可播放的音频附件发送"
    ],
    limitations: [
      "不要把本地文件路径写进 text；收件人打不开你机器上的路径",
      "超长正文可能被飞书客户端截断，复杂报告宜拆条或附件",
      "仅当 format=markdown 时表格/标题才会渲染；默认 plain 会显示管道符原文"
    ],
    writingTips: [
      "任务汇报、线程列表、对比结果优先用 Markdown 表格与标题",
      "链接写成 [标题](https://...)",
      "代码用 fenced code block（```）",
      "推送前可调用 get_channel_format_guide({ channel: \"feishu\" }) 核对"
    ],
    mediaNotes:
      "先把真实文件复制到 PUSH_OUTBOX_ROOT，再通过 media[].path 引用；不要把路径塞进 text。"
  },
  weixin: {
    channel: "weixin",
    recommendedFormat: "plain",
    supportedFormats: ["plain", "markdown"],
    summary: "微信：推荐 format=plain（Markdown 多半原样显示；链接可预览）",
    capabilities: [
      "纯文本分段与换行",
      "http(s) 链接通常可被客户端预览",
      "图片/文件/音视频通过 media[] 独立投递"
    ],
    limitations: [
      "format=markdown 不会按飞书那样渲染表格/标题，符号常原样显示",
      "不要依赖 **加粗**、表格管道符或复杂嵌套列表",
      "主动推送媒体必须走 outbox 沙箱路径"
    ],
    writingTips: [
      "用短段落 + 空行，不用 Markdown 表格",
      "关键信息放前两行，细节用「1. 2. 3.」编号",
      "需要结构化展示时优先发文件附件，而不是巨型 Markdown"
    ],
    mediaNotes:
      "媒体必须先落入 PUSH_OUTBOX_ROOT，再填 media[]；media.type=audio 会发送为可播放的音频附件，text 里写本地路径不会变成媒体。"
  },
  qq: {
    channel: "qq",
    recommendedFormat: "plain",
    supportedFormats: ["plain", "markdown"],
    summary: "QQ：主动推送当前不可用；对话侧 Markdown 取决于账号配置",
    capabilities: [
      "私聊对话回复可按账号 markdownSupport 发送 Markdown",
      "规范层仍接受 format=plain|markdown，便于将来打通主动推送"
    ],
    limitations: [
      "Agent 主动推送（HTTP/MCP）当前固定失败：channel_unsupported（无已验证的主动发消息 API）",
      "不要假设 QQ 目标能像飞书一样渲染 GFM 表格",
      "请改用微信/飞书目标做主动推送，或走已建立会话的对话回复链路"
    ],
    writingTips: [
      "若 list_push_targets 显示 channel=qq，改选其他渠道目标",
      "对话回复尽量短句；Markdown 仅在确认账号开启后使用"
    ],
    mediaNotes:
      "主动推送媒体同样不可用；已建立的 QQ 对话回复链路支持图片、音频、视频和文件。"
  }
};

export function listChannelFormatGuides(): ChannelFormatGuide[] {
  return [
    CHANNEL_FORMAT_GUIDES.feishu,
    CHANNEL_FORMAT_GUIDES.weixin,
    CHANNEL_FORMAT_GUIDES.qq
  ];
}

export function getChannelFormatGuide(channel: PushChannel): ChannelFormatGuide {
  return CHANNEL_FORMAT_GUIDES[channel];
}

export function isPushChannel(value: string): value is PushChannel {
  return value === "feishu" || value === "weixin" || value === "qq";
}

export function resolveChannelFormatGuide(input: {
  channel?: string;
  target?: string;
  targets?: PublicTargetLike[];
}): ChannelFormatGuide | null {
  if (input.channel) {
    return isPushChannel(input.channel) ? getChannelFormatGuide(input.channel) : null;
  }
  if (!input.target) {
    return null;
  }
  const matched = (input.targets ?? []).find((target) => target.alias === input.target);
  if (!matched || !isPushChannel(matched.channel)) {
    return null;
  }
  return getChannelFormatGuide(matched.channel);
}

export function enrichPushTargetsWithFormatGuide<T extends { targets?: PublicTargetLike[] }>(
  payload: T
): T {
  const targets = payload.targets;
  if (!Array.isArray(targets)) {
    return payload;
  }
  return {
    ...payload,
    targets: targets.map((target) => {
      if (!isPushChannel(target.channel)) {
        return target;
      }
      const guide = getChannelFormatGuide(target.channel);
      return {
        ...target,
        recommendedFormat: guide.recommendedFormat,
        formatSummary: guide.summary
      };
    })
  };
}

export const CHANNEL_FORMAT_GUIDE_TOOL_SUMMARY =
  "Channel formatting: feishu→markdown (tables/headings/code via post md); " +
  "weixin→plain (markdown usually shows raw); qq proactive push unsupported. " +
  "Call get_channel_format_guide before composing rich text.";
