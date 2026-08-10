import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode
} from "react";
import { Link, isRouteErrorResponse, useRouteError } from "react-router";
import { ControlApiError, controlApi } from "./api-client.js";
import {
  channelLabel,
  createChannel,
  deleteChannel,
  loadChannels,
  loadOverview,
  restartChannel,
  statusLabel,
  testChannel,
  type ActivitySummary,
  type ChannelCreateInput,
  type ChannelSummary,
  type HealthStatus,
  type OverviewData
} from "./control-data.js";

type ResourceState<T> = {
  data: T | null;
  loading: boolean;
  error: Error | null;
};

type StreamState = "connecting" | "connected" | "reconnecting";

export function OverviewPage() {
  const resource = useResource(loadOverview);
  const streamState = useLiveRefresh(resource.reload, resource.data !== null);

  return (
    <div className="page page-overview">
      <PageTitle title="概览" loading={resource.loading} onRefresh={resource.reload} />
      {resource.error && !resource.data ? <LoadError error={resource.error} onRetry={resource.reload} /> : null}
      {resource.error && resource.data ? <InlineNotice tone="danger">刷新失败：{errorMessage(resource.error)}</InlineNotice> : null}
      <section className="section" aria-labelledby="system-status-title">
        <h2 id="system-status-title">系统状态</h2>
        {resource.data
          ? <SystemStatusBand data={resource.data} streamState={streamState} />
          : <StatusLoading />}
      </section>
      <section className="section" aria-labelledby="channel-status-title">
        <div className="section-header">
          <h2 id="channel-status-title">渠道状态</h2>
          <Link className="button button-primary" to="/channels">添加渠道</Link>
        </div>
        {resource.data
          ? <ChannelTable channels={resource.data.channels} compact />
          : <TableLoading />}
      </section>
      <section className="section" aria-labelledby="recent-activity-title">
        <h2 id="recent-activity-title">最近活动</h2>
        {resource.data
          ? <ActivityList activities={resource.data.activities} />
          : <ActivityLoading />}
        <Link className="button button-secondary diagnostics-link" to="/diagnostics">查看诊断</Link>
      </section>
    </div>
  );
}

export function ChannelsPage() {
  const resource = useResource(loadChannels);
  const [showForm, setShowForm] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ready" | "danger"; message: string } | null>(null);
  useLiveRefresh(resource.reload, resource.data !== null);

  const performAction = async (key: string, successMessage: string, action: () => Promise<void>) => {
    setPendingAction(key);
    setNotice(null);
    try {
      await action();
      await resource.reload();
      setNotice({ tone: "ready", message: successMessage });
    } catch (error) {
      setNotice({ tone: "danger", message: errorMessage(error) });
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <div className="page page-channels">
      <div className="page-heading page-heading-actions">
        <div>
          <h1>渠道</h1>
          <p>管理微信、飞书和 QQ 渠道账户；凭据只通过本机 Secret Reference 引用。</p>
        </div>
        <div className="heading-actions">
          <button className="button button-secondary" type="button" onClick={() => void resource.reload()} disabled={resource.loading}>刷新</button>
          <button className="button button-primary" type="button" onClick={() => setShowForm((visible) => !visible)}>{showForm ? "取消添加" : "添加渠道"}</button>
        </div>
      </div>
      {showForm
        ? <ChannelForm
            pending={pendingAction === "create"}
            onSubmit={(input) => performAction("create", "渠道已添加", async () => {
              await createChannel(input);
              setShowForm(false);
            })}
          />
        : null}
      {notice ? <InlineNotice tone={notice.tone}>{notice.message}</InlineNotice> : null}
      {resource.error && !resource.data ? <LoadError error={resource.error} onRetry={resource.reload} /> : null}
      {resource.error && resource.data ? <InlineNotice tone="danger">刷新失败：{errorMessage(resource.error)}</InlineNotice> : null}
      <section className="section" aria-labelledby="channel-accounts-title">
        <div className="section-header">
          <div>
            <h2 id="channel-accounts-title">渠道账户</h2>
            <p className="section-description">{resource.data ? `共 ${resource.data.length} 个账户` : "正在读取账户"}</p>
          </div>
        </div>
        {resource.data
          ? <ChannelTable
              channels={resource.data}
              pendingAction={pendingAction}
              onTest={(channel) => performAction(`test:${channel.id}`, `${channel.displayName} 测试完成`, () => testChannel(channel.id))}
              onRestart={(channel) => performAction(`restart:${channel.id}`, `${channel.displayName} 已重启`, () => restartChannel(channel.id))}
              onDelete={(channel) => {
                if (window.confirm(`确定删除“${channel.displayName}”吗？此操作会应用新的渠道配置。`)) {
                  void performAction(`delete:${channel.id}`, `${channel.displayName} 已删除`, () => deleteChannel(channel.id));
                }
              }}
            />
          : <TableLoading />}
      </section>
    </div>
  );
}

export function SectionPlaceholder({ title, description }: { title: string; description: string }) {
  return (
    <div className="page page-placeholder">
      <div className="page-heading">
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="placeholder-surface">
        <div className="placeholder-rule" />
        <div className="placeholder-rule placeholder-rule-short" />
      </div>
    </div>
  );
}

export function RouteErrorPage() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : errorMessage(error);
  return (
    <div className="route-error">
      <h1>无法打开页面</h1>
      <p>{message}</p>
      <Link className="button button-primary" to="/">返回概览</Link>
    </div>
  );
}

function PageTitle({ title, loading, onRefresh }: { title: string; loading: boolean; onRefresh(): Promise<void> }) {
  return (
    <div className="page-heading page-heading-actions">
      <h1>{title}</h1>
      <button className="button button-secondary" type="button" onClick={() => void onRefresh()} disabled={loading}>
        {loading ? "正在刷新" : "刷新"}
      </button>
    </div>
  );
}

function SystemStatusBand({ data, streamState }: { data: OverviewData; streamState: StreamState }) {
  const counts = data.health.components.reduce((result, component) => {
    result[component.status] += 1;
    return result;
  }, { ready: 0, degraded: 0, action_required: 0, offline: 0 });
  const attentionCount = counts.degraded + counts.action_required + counts.offline;
  return (
    <div className="status-band" aria-label={`系统${statusLabel(data.health.status)}`}>
      <StatusSummary
        tone={toneForStatus(data.health.status)}
        label={statusLabel(data.health.status)}
        detail={`${data.health.components.length} 个组件，检查于 ${formatDateTime(data.health.checkedAt)}`}
      />
      <StatusSummary
        tone={attentionCount === 0 ? "ready" : "warning"}
        label={attentionCount === 0 ? "组件全部正常" : `${attentionCount} 个组件需关注`}
        detail={`${counts.ready} 正常 · ${counts.action_required} 待操作 · ${counts.offline} 离线`}
      />
      <StatusSummary
        tone={streamState === "connected" ? "ready" : streamState === "reconnecting" ? "warning" : "neutral"}
        label={streamState === "connected" ? "实时事件已连接" : streamState === "reconnecting" ? "实时事件重连中" : "正在连接实时事件"}
        detail={data.system.activeRevision ? `配置 ${shortRevision(data.system.activeRevision)} · ${data.system.state}` : `尚未应用配置 · ${data.system.state}`}
      />
    </div>
  );
}

function StatusSummary({ tone, label, detail }: { tone: "ready" | "warning" | "danger" | "neutral"; label: string; detail: string }) {
  return (
    <div className="status-summary-item">
      <span className={`status-ring status-ring-${tone}`} aria-hidden="true" />
      <div><strong>{label}</strong><span>{detail}</span></div>
    </div>
  );
}

function ChannelTable({
  channels,
  compact = false,
  pendingAction,
  onTest,
  onRestart,
  onDelete
}: {
  channels: ChannelSummary[];
  compact?: boolean;
  pendingAction?: string | null;
  onTest?: (channel: ChannelSummary) => void;
  onRestart?: (channel: ChannelSummary) => void;
  onDelete?: (channel: ChannelSummary) => void;
}) {
  if (channels.length === 0) {
    return <div className="empty-state" role="status"><strong>尚未配置渠道</strong><span>添加微信、飞书或 QQ 账户后，状态会显示在这里。</span></div>;
  }
  return (
    <div className={`table-frame${compact ? " table-compact" : ""}`}>
      <div className="table-header-row"><span>渠道</span><span>状态</span><span>最后活动</span><span>操作</span></div>
      {channels.map((channel) => (
        <div className="table-data-row" key={channel.id}>
          <div className="channel-identity"><span className={`channel-mark channel-mark-${channel.channel}`} aria-hidden="true">{channelLabel(channel.channel).slice(0, 1)}</span><span><strong>{channel.displayName}</strong><small>{channel.accountId}</small></span></div>
          <div><span className={`status-text status-text-${toneForStatus(channel.status)}`}><span className="status-dot" />{channel.enabled ? statusLabel(channel.status) : "已停用"}</span><small className="cell-detail">{channel.message}</small></div>
          <span>{channel.lastActivityAt ? formatDateTime(channel.lastActivityAt) : "暂无活动"}</span>
          <div className="row-actions">
            {compact
              ? <Link to="/channels">查看</Link>
              : <>
                  <button type="button" disabled={Boolean(pendingAction)} onClick={() => onTest?.(channel)}>{pendingAction === `test:${channel.id}` ? "测试中" : "测试"}</button>
                  <button type="button" disabled={Boolean(pendingAction)} onClick={() => onRestart?.(channel)}>{pendingAction === `restart:${channel.id}` ? "重启中" : "重启"}</button>
                  <button className="danger-link" type="button" disabled={Boolean(pendingAction)} onClick={() => onDelete?.(channel)}>{pendingAction === `delete:${channel.id}` ? "删除中" : "删除"}</button>
                </>}
          </div>
        </div>
      ))}
    </div>
  );
}

function ActivityList({ activities }: { activities: ActivitySummary[] }) {
  if (activities.length === 0) {
    return <div className="empty-state empty-state-plain" role="status"><strong>暂无运行事件</strong><span>组件、配置与 Turn 事件会实时显示在这里。</span></div>;
  }
  return (
    <div className="activity-list">
      {activities.map((activity) => (
        <div className="activity-row" key={activity.eventId}>
          <span className="activity-indicator" aria-hidden="true" />
          <strong>{activityTitle(activity.type)}</strong>
          <span>{activity.component}</span>
          <time dateTime={activity.occurredAt}>{formatDateTime(activity.occurredAt)}</time>
        </div>
      ))}
    </div>
  );
}

function ChannelForm({ pending, onSubmit }: { pending: boolean; onSubmit(input: ChannelCreateInput): Promise<void> }) {
  const [channel, setChannel] = useState<ChannelCreateInput["channel"]>("weixin");
  const [accountId, setAccountId] = useState("");
  const [appId, setAppId] = useState("");
  const [secretRef, setSecretRef] = useState("");

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input: ChannelCreateInput = channel === "weixin"
      ? { channel: "weixin", accountId: accountId.trim(), enabled: true }
      : { channel, accountId: accountId.trim(), enabled: true, appId: appId.trim(), secretRef: secretRef.trim() };
    void onSubmit(input);
  };

  return (
    <form className="channel-form" onSubmit={submit}>
      <div className="form-heading"><h2>添加渠道</h2><p>Secret Reference 指向本机 Keychain，不在页面中填写明文凭据。</p></div>
      <label>渠道<select value={channel} onChange={(event) => setChannel(event.target.value as ChannelCreateInput["channel"])}><option value="weixin">微信</option><option value="feishu">飞书</option><option value="qq">QQ</option></select></label>
      <label>账户 ID<input required maxLength={128} value={accountId} onChange={(event) => setAccountId(event.target.value)} placeholder="例如 personal" /></label>
      {channel !== "weixin"
        ? <><label>App ID<input required value={appId} onChange={(event) => setAppId(event.target.value)} /></label><label>Secret Reference<input required pattern="[a-z0-9][a-z0-9/_-]*" value={secretRef} onChange={(event) => setSecretRef(event.target.value)} placeholder={`${channel}/personal`} /></label></>
        : null}
      <button className="button button-primary" type="submit" disabled={pending}>{pending ? "正在添加" : "保存并应用"}</button>
    </form>
  );
}

function LoadError({ error, onRetry }: { error: Error; onRetry(): Promise<void> }) {
  return (
    <div className="load-error" role="alert">
      <div><strong>无法读取管理数据</strong><span>{errorMessage(error)}</span></div>
      <button className="button button-secondary" type="button" onClick={() => void onRetry()}>重试</button>
    </div>
  );
}

function InlineNotice({ tone, children }: { tone: "ready" | "danger"; children: ReactNode }) {
  return <div className={`inline-notice inline-notice-${tone}`} role="status" aria-live="polite">{children}</div>;
}

function StatusLoading() {
  return <div className="status-band" aria-label="正在读取系统状态"><StatusPlaceholder tone="ready" label="连接管理服务" /><StatusPlaceholder tone="warning" label="读取组件状态" /><StatusPlaceholder tone="neutral" label="等待实时事件" /></div>;
}

function StatusPlaceholder({ tone, label }: { tone: "ready" | "warning" | "neutral"; label: string }) {
  return <StatusSummary tone={tone} label={label} detail="正在加载" />;
}

function TableLoading() {
  return <div className="table-frame table-loading" role="status" aria-live="polite"><div className="table-header-row"><span>渠道</span><span>状态</span><span>最后活动</span><span>操作</span></div><LoadingRow width="58%" /><LoadingRow width="44%" /><LoadingRow width="51%" /></div>;
}

function ActivityLoading() {
  return <div className="activity-loading" role="status" aria-label="正在读取最近活动"><LoadingLine width="72%" /><LoadingLine width="61%" /><LoadingLine width="68%" /></div>;
}

function LoadingRow({ width }: { width: string }) {
  return <div className="table-loading-row"><LoadingLine width={width} /><LoadingLine width="38%" /><LoadingLine width="54%" /><LoadingLine width="42%" /></div>;
}

function LoadingLine({ width }: { width: string }) {
  return <span className="loading-line" style={{ width }} aria-hidden="true" />;
}

function useResource<T>(loader: () => Promise<T>) {
  const [state, setState] = useState<ResourceState<T>>({ data: null, loading: true, error: null });
  const requestId = useRef(0);
  const reload = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await loader();
      if (currentRequest === requestId.current) {
        setState({ data, loading: false, error: null });
      }
    } catch (error) {
      if (currentRequest === requestId.current) {
        setState((current) => ({ ...current, loading: false, error: normalizeError(error) }));
      }
    }
  }, [loader]);
  useEffect(() => {
    void reload();
    return () => {
      requestId.current += 1;
    };
  }, [reload]);
  return { ...state, reload };
}

function useLiveRefresh(refresh: () => Promise<void>, enabled: boolean): StreamState {
  const [state, setState] = useState<StreamState>("connecting");
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const stream = new EventSource(controlApi.eventStreamUrl(), { withCredentials: true });
    let refreshTimer: number | null = null;
    stream.onopen = () => setState("connected");
    stream.onerror = () => setState("reconnecting");
    stream.addEventListener("bridge-event", () => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      refreshTimer = window.setTimeout(() => void refresh(), 150);
    });
    return () => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      stream.close();
    };
  }, [enabled, refresh]);
  return state;
}

function toneForStatus(status: HealthStatus): "ready" | "warning" | "danger" {
  return status === "ready" ? "ready" : status === "offline" ? "danger" : "warning";
}

function activityTitle(type: string): string {
  const titles: Record<string, string> = {
    "config.apply.completed": "配置已应用",
    "config.apply.failed": "配置应用失败",
    "turn.completed": "Turn 已完成",
    "turn.failed": "Turn 失败",
    "binding.updated": "线程绑定已更新",
    "channel.test.completed": "渠道连接测试完成",
    "daemon.state.changed": "后台状态已更新",
    "component.started": "组件已启动",
    "component.restarted": "组件已重启"
  };
  return titles[type] ?? type;
}

function shortRevision(revision: string): string {
  return revision.length > 12 ? revision.slice(0, 12) : revision;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" }).format(new Date(value));
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  if (error instanceof ControlApiError && error.requestId) {
    return `${error.message}（请求 ${error.requestId}）`;
  }
  return error instanceof Error ? error.message : "页面加载失败";
}
