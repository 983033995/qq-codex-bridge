import { calculateConfigRevision, stableSerialize } from "./revision.js";
import type { VNextConfig } from "./schema.js";

export type ApplyEffect =
  | { type: "hot_reload"; component: string }
  | { type: "component_restart"; component: string }
  | { type: "daemon_restart" };

export type ApplyPlan = {
  revision: string;
  effects: ApplyEffect[];
};

export function planConfigApply(
  current: VNextConfig | null,
  next: VNextConfig
): ApplyPlan {
  const effects: ApplyEffect[] = [];
  if (!current || changed(current.runtime, next.runtime)) {
    effects.push({ type: "daemon_restart" });
  }
  if (!current || changed(current.codex, next.codex)) {
    effects.push({ type: "component_restart", component: "codex" });
  }
  if (!current || changed(current.router, next.router)) {
    effects.push({ type: "hot_reload", component: "router" });
  }
  if (!current || changed(current.push, next.push)) {
    effects.push({ type: "hot_reload", component: "push" });
  }
  if (!current || changed(current.queues, next.queues)) {
    effects.push({ type: "hot_reload", component: "queues" });
  }

  const changedAccounts = changedChannelAccounts(current?.channels ?? [], next.channels);
  if (changedAccounts.some((accountKey) => accountKey.startsWith("weixin:"))) {
    effects.push({ type: "component_restart", component: "weixin-worker" });
  }
  for (const accountKey of changedAccounts.filter((key) => !key.startsWith("weixin:"))) {
    effects.push({ type: "component_restart", component: `channel:${accountKey}` });
  }

  return { revision: calculateConfigRevision(next), effects };
}

function changed(left: unknown, right: unknown): boolean {
  return stableSerialize(left) !== stableSerialize(right);
}

function changedChannelAccounts(
  current: VNextConfig["channels"],
  next: VNextConfig["channels"]
): string[] {
  const before = new Map(current.map((channel) => [key(channel), channel]));
  const after = new Map(next.map((channel) => [key(channel), channel]));
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((accountKey) => changed(before.get(accountKey), after.get(accountKey)))
    .sort();
}

function key(channel: VNextConfig["channels"][number]): string {
  return `${channel.channel}:${channel.accountId}`;
}
