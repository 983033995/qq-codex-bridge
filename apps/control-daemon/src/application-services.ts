import { BindConversationSpace } from "../../../packages/application/src/index.js";
import {
  applyConfiguration,
  planConfigApply,
  type ChannelConfig,
  type VNextConfig
} from "../../../packages/config/src/index.js";
import {
  VNextDomainError,
  type ConversationSpaceId,
  type Turn
} from "../../../packages/domain/src/vnext/index.js";
import type {
  CodexPort,
  ConfigStorePort,
  ConversationSpaceRepository,
  IntentRouterPort,
  MessageLedger,
  PushRepository,
  RoutingDecisionRepository,
  RuntimeEventRepository,
  SecretStorePort,
  ThreadBindingRepository,
  TurnRepository
} from "../../../packages/ports/src/vnext/index.js";
import type { ControlDaemonCompositionRoot } from "./composition-root.js";
import type {
  ControlApiInvocation,
  ControlApiServices
} from "./control-api.js";

type PageQuery = { limit: number; cursor?: string };
type ChannelRuntime = {
  health?(channelId: string): Promise<{ status: string; message: string; lastActivityAt?: string | null }>;
  test?(channelId: string): Promise<unknown>;
  restart?(channelId: string): Promise<unknown>;
};

export type ControlApiApplicationServicesOptions = {
  daemon: Pick<ControlDaemonCompositionRoot, "state" | "activeRevision" | "health" | "applyPlan">;
  configStore: ConfigStorePort<VNextConfig>;
  secretStore: SecretStorePort;
  codex: CodexPort;
  spaces: ConversationSpaceRepository;
  bindings: ThreadBindingRepository;
  messages: MessageLedger;
  turns: TurnRepository;
  listTurns(input: PageQuery): Promise<{ items: Turn[]; nextCursor: string | null }>;
  decisions: RoutingDecisionRepository;
  runtimeEvents: RuntimeEventRepository;
  push: PushRepository;
  bindConversationSpace: BindConversationSpace;
  router?: IntentRouterPort;
  channels?: ChannelRuntime;
  exportDiagnostics?(includeLogs: boolean): Promise<unknown>;
  version?: string;
  now?: () => Date;
};

export class ControlApiApplicationServices implements ControlApiServices {
  private readonly now: () => Date;
  constructor(private readonly options: ControlApiApplicationServicesOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async execute(invocation: ControlApiInvocation): Promise<unknown> {
    switch (invocation.operation) {
      case "health.get":
        return this.options.daemon.health.check();
      case "system.status":
        return {
          state: this.options.daemon.state,
          activeRevision: this.options.daemon.activeRevision,
          version: this.options.version ?? null
        };
      case "channels.list":
        return this.listChannels();
      case "channels.create":
        return this.createChannel(invocation.body as ChannelConfig);
      case "channels.test":
        return this.channelAction("test", requiredParam(invocation, "id"));
      case "channels.restart":
        return this.channelAction("restart", requiredParam(invocation, "id"));
      case "channels.delete":
        return this.deleteChannel(requiredParam(invocation, "id"));
      case "spaces.list":
        return this.listSpaces(invocation.query as PageQuery);
      case "spaces.get":
        return this.getSpace(requiredParam(invocation, "id"));
      case "spaces.messages.list":
        return this.options.messages.listBySpace({
          spaceId: requiredParam(invocation, "id") as ConversationSpaceId,
          ...(invocation.query as PageQuery)
        });
      case "spaces.bindings.create":
        return this.createBinding(requiredParam(invocation, "id"), invocation.body as {
          threadId: string;
          mode: "exclusive" | "shared";
          replaceActive: boolean;
        });
      case "spaces.bindings.deleteCurrent":
        return { deleted: await this.options.bindConversationSpace.unbind(requiredParam(invocation, "id") as ConversationSpaceId) };
      case "threads.list":
        return this.listThreads(invocation.query as PageQuery);
      case "threads.create":
        return this.options.codex.createThread(invocation.body as { title?: string; cwd?: string });
      case "threads.update":
        await this.options.codex.renameThread(requiredParam(invocation, "id"), (invocation.body as { title: string }).title);
        return { updated: true };
      case "turns.list":
        return this.options.listTurns(invocation.query as PageQuery);
      case "turns.interrupt":
        return this.interruptTurn(requiredParam(invocation, "id"));
      case "router.config.get":
        return (await this.currentConfig()).router;
      case "router.config.update":
        return this.updateRouter(invocation.body as VNextConfig["router"]);
      case "router.test":
        return this.testRouter(invocation.body as { text: string; spaceId?: string });
      case "router.decisions.list":
        return this.options.decisions.list(invocation.query as PageQuery);
      case "config.get":
        return this.currentConfigSnapshot();
      case "config.plan":
        return planConfigApply((await this.options.configStore.read())?.value ?? null, (invocation.body as { candidate: VNextConfig }).candidate);
      case "config.apply": {
        const body = invocation.body as { candidate: VNextConfig; secretChanges: Array<{ ref: string; value: string | null }> };
        return this.applyConfig(body.candidate, body.secretChanges);
      }
      case "diagnostics.events.list":
        return this.listEvents(invocation.query as PageQuery);
      case "diagnostics.export":
        return this.exportDiagnostics((invocation.body as { includeLogs: boolean }).includeLogs);
      case "pushTargets.list":
        return this.options.push.listTargets();
      case "pushTargets.create":
        return this.savePushTarget(invocation.body as { alias: string; spaceId: string; enabled: boolean });
      case "pushTargets.delete":
        return this.deletePushTarget(requiredParam(invocation, "alias"));
    }
  }

  private async currentConfig(): Promise<VNextConfig> {
    const snapshot = await this.options.configStore.read();
    if (!snapshot) {
      throw new VNextDomainError("CONFIG_INVALID", "配置文件尚未初始化");
    }
    return snapshot.value;
  }

  private async currentConfigSnapshot(): Promise<{ value: VNextConfig; revision: string }> {
    const snapshot = await this.options.configStore.read();
    if (!snapshot) {
      throw new VNextDomainError("CONFIG_INVALID", "配置文件尚未初始化");
    }
    return snapshot;
  }

  private async applyConfig(
    candidate: VNextConfig,
    secretChanges: readonly { ref: string; value: string | null }[]
  ): Promise<unknown> {
    const current = await this.options.configStore.read();
    const preview = planConfigApply(current?.value ?? null, candidate);
    if (preview.effects.some((effect) => effect.type === "daemon_restart")) {
      throw new VNextDomainError(
        "CONFIG_INVALID",
        "运行地址或并发度变更需要由外部服务管理器重启 Daemon；当前会话不会假装已生效"
      );
    }
    return applyConfiguration({
      configStore: this.options.configStore,
      secretStore: this.options.secretStore,
      nextConfig: candidate,
      secretChanges,
      applyPlan: (plan) => this.options.daemon.applyPlan(plan)
    });
  }

  private async listChannels(): Promise<unknown[]> {
    const config = await this.currentConfig();
    return Promise.all(config.channels.map(async (channel) => {
      const id = channelId(channel);
      const runtime = channel.enabled ? await this.options.channels?.health?.(id) : null;
      const hasSecret = channel.channel === "weixin"
        ? true
        : await this.options.secretStore.get(channel.secretRef).then((value) => value !== null);
      const status = !channel.enabled
        ? "disabled"
        : runtime?.status ?? (hasSecret ? "degraded" : "action_required");
      return {
        id,
        accountKey: id,
        channel: channel.channel,
        accountId: channel.accountId,
        displayName: `${channelName(channel.channel)} · ${channel.accountId}`,
        enabled: channel.enabled,
        status,
        message: runtime?.message ?? (!hasSecret ? "Secret Reference 尚未写入 Keychain" : "渠道运行时尚未连接"),
        lastActivityAt: runtime?.lastActivityAt ?? null
      };
    }));
  }

  private async createChannel(channel: ChannelConfig): Promise<unknown> {
    const config = await this.currentConfig();
    const id = channelId(channel);
    if (config.channels.some((candidate) => channelId(candidate) === id)) {
      throw new VNextDomainError("CONFIG_INVALID", `渠道账户 '${id}' 已存在`);
    }
    const plan = await this.applyConfig({ ...config, channels: [...config.channels, channel] }, []);
    return { channelId: id, plan };
  }

  private async deleteChannel(id: string): Promise<unknown> {
    const config = await this.currentConfig();
    const channels = config.channels.filter((channel) => channelId(channel) !== id);
    if (channels.length === config.channels.length) {
      throw new VNextDomainError("CONFIG_INVALID", `渠道账户 '${id}' 不存在`);
    }
    const plan = await this.applyConfig({ ...config, channels }, []);
    return { deleted: true, plan };
  }

  private async channelAction(action: "test" | "restart", id: string): Promise<unknown> {
    const handler = this.options.channels?.[action];
    if (!handler) {
      throw new Error(`Channel ${action} is unavailable because the runtime adapter is not connected`);
    }
    return handler(id);
  }

  private async listSpaces(query: PageQuery): Promise<unknown> {
    const page = await this.options.spaces.list(query);
    return {
      ...page,
      items: await Promise.all(page.items.map(async (space) => ({
        ...space,
        binding: await this.options.bindings.getActiveBySpace(space.spaceId)
      })))
    };
  }

  private async getSpace(id: string): Promise<unknown> {
    const spaceId = id as ConversationSpaceId;
    const space = await this.options.spaces.get(spaceId);
    if (!space) {
      throw new VNextDomainError("CODEX_THREAD_NOT_FOUND", `对话空间 '${id}' 不存在`);
    }
    return { ...space, binding: await this.options.bindings.getActiveBySpace(spaceId) };
  }

  private async createBinding(
    spaceId: string,
    input: { threadId: string; mode: "exclusive" | "shared"; replaceActive: boolean }
  ): Promise<unknown> {
    const thread = (await this.options.codex.listThreads({ limit: 200 }))
      .find((candidate) => candidate.threadId === input.threadId);
    if (!thread) {
      throw new VNextDomainError("CODEX_THREAD_NOT_FOUND", `Codex thread '${input.threadId}' was not found`);
    }
    return this.options.bindConversationSpace.execute({
      spaceId: spaceId as ConversationSpaceId,
      thread,
      mode: input.mode,
      replaceActive: input.replaceActive
    });
  }

  private async listThreads(query: PageQuery): Promise<unknown> {
    const items = await this.options.codex.listThreads(query);
    return { items, nextCursor: null };
  }

  private async interruptTurn(turnId: string): Promise<unknown> {
    const turn = await this.options.turns.get(turnId);
    if (!turn) {
      throw new VNextDomainError("CODEX_THREAD_NOT_FOUND", `Turn '${turnId}' was not found`);
    }
    await this.options.codex.interruptTurn(turn.threadId, turn.turnId);
    const completedAt = this.now().toISOString();
    await this.options.turns.save({ ...turn, status: "interrupted", completedAt });
    return { interrupted: true, completedAt };
  }

  private async updateRouter(router: VNextConfig["router"]): Promise<unknown> {
    const config = await this.currentConfig();
    const plan = await this.applyConfig({ ...config, router }, []);
    return { router, plan };
  }

  private async testRouter(input: { text: string; spaceId?: string }): Promise<unknown> {
    if (!this.options.router) {
      throw new Error("Router adapter is not connected");
    }
    const space = input.spaceId
      ? await this.options.spaces.get(input.spaceId as ConversationSpaceId)
      : null;
    const binding = space ? await this.options.bindings.getActiveBySpace(space.spaceId) : null;
    return this.options.router.route({
      message: input.text,
      spaceDisplayName: space?.displayName ?? "管理台测试",
      currentThreadTitle: binding?.threadTitle ?? null,
      candidateThreads: (await this.options.codex.listThreads({ limit: 20 })).map((thread) => ({
        title: thread.title,
        projectName: thread.projectName,
        relativeTime: thread.updatedAt
      })),
      recentControlMessages: [],
      allowedActionTypes: ["thread.list", "thread.current", "thread.switch", "thread.create", "turn.status", "turn.interrupt", "system.status"]
    });
  }

  private async listEvents(query: PageQuery): Promise<unknown> {
    const page = await this.options.runtimeEvents.list(query);
    return {
      ...page,
      items: page.items.map((event) => ({
        eventId: event.eventId,
        component: event.component,
        type: event.type,
        occurredAt: event.createdAt,
        payload: parsePayload(event.payloadJson)
      }))
    };
  }

  private async exportDiagnostics(includeLogs: boolean): Promise<unknown> {
    if (!this.options.exportDiagnostics) {
      throw new Error("Diagnostics export is not configured");
    }
    return this.options.exportDiagnostics(includeLogs);
  }

  private async savePushTarget(input: { alias: string; spaceId: string; enabled: boolean }): Promise<unknown> {
    const existing = await this.options.push.getTarget(input.alias);
    const now = this.now().toISOString();
    const target = {
      alias: input.alias,
      spaceId: input.spaceId as ConversationSpaceId,
      enabled: input.enabled,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    await this.options.push.saveTarget(target);
    return target;
  }

  private async deletePushTarget(alias: string): Promise<unknown> {
    const existing = await this.options.push.getTarget(alias);
    if (!existing) {
      return { deleted: false };
    }
    await this.options.push.saveTarget({ ...existing, enabled: false, updatedAt: this.now().toISOString() });
    return { deleted: true };
  }
}

function requiredParam(invocation: ControlApiInvocation, name: string): string {
  const value = invocation.params[name]?.trim();
  if (!value) {
    throw new Error(`Missing route parameter '${name}'`);
  }
  return value;
}

function channelId(channel: Pick<ChannelConfig, "channel" | "accountId">): string {
  return `${channel.channel}:${channel.accountId}`;
}

function channelName(channel: ChannelConfig["channel"]): string {
  return { weixin: "微信", feishu: "飞书", qq: "QQ" }[channel];
}

function parsePayload(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { invalidPayload: true };
  }
}
