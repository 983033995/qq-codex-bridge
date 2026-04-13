import fs from "node:fs";
import path from "node:path";

export type WeixinGatewayOutboundMessage = {
  id: string;
  peerId: string;
  chatType: "c2c" | "group";
  content: string;
  replyToMessageId?: string;
  createdAt: string;
};

export class WeixinGatewayMessageStore {
  private readonly messages: WeixinGatewayOutboundMessage[] = [];

  constructor(
    private readonly filePath: string,
    private readonly limit: number
  ) {
    this.loadFromDisk();
  }

  append(message: WeixinGatewayOutboundMessage): void {
    this.messages.push(message);
    this.trimToLimit();
    this.persistLine(message);
  }

  listRecent(): WeixinGatewayOutboundMessage[] {
    return [...this.messages].reverse();
  }

  private loadFromDisk(): void {
    if (!fs.existsSync(this.filePath)) {
      return;
    }

    const content = fs.readFileSync(this.filePath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const parsed = JSON.parse(trimmed) as WeixinGatewayOutboundMessage;
        this.messages.push(parsed);
      } catch {
        // ignore malformed historical lines
      }
    }

    this.trimToLimit();
  }

  private persistLine(message: WeixinGatewayOutboundMessage): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(message)}\n`, "utf8");
  }

  private trimToLimit(): void {
    if (this.messages.length <= this.limit) {
      return;
    }

    this.messages.splice(0, this.messages.length - this.limit);
  }
}
