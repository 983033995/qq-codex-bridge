import type { PushChannel, PushEgressPort } from "../../ports/src/push.js";

export class PushChannelRegistry {
  private readonly egressByKey = new Map<string, PushEgressPort>();

  register(channel: PushChannel, accountKey: string, egress: PushEgressPort): void {
    this.egressByKey.set(key(channel, accountKey), egress);
  }

  resolve(channel: PushChannel, accountKey: string): PushEgressPort | null {
    return this.egressByKey.get(key(channel, accountKey)) ?? null;
  }
}

function key(channel: PushChannel, accountKey: string): string {
  return `${channel}:${accountKey}`;
}
