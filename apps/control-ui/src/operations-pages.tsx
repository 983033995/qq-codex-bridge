import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode
} from "react";
import {
  bindSpace,
  createThread,
  exportDiagnostics,
  interruptTurn,
  loadDiagnostics,
  loadRouter,
  loadSettings,
  loadSpaces,
  loadTasks,
  planAndApplyConfig,
  testRouter,
  unbindSpace,
  updateRouter,
  type ApplyPlan,
  type DiagnosticEvent,
  type RouterConfig,
  type SpaceItem,
  type ThreadItem,
  type VNextConfig
} from "./operations-data.js";

export function SpacesPage() {
  const resource = useOperationResource(loadSpaces);
  return (
    <OperationPage title="会话空间" description="查看每个聊天空间与 Codex 线程的绑定；共享绑定需要再次确认。">
      <ResourceBoundary resource={resource}>
        {(data) => data.spaces.length === 0
          ? <Empty title="暂无会话空间" detail="渠道收到首条消息后，会话空间会出现在这里。" />
          : <div className="record-list" aria-label="会话空间列表">
              {data.spaces.map((space) => <SpaceCard key={space.spaceId} space={space} threads={data.threads} reload={resource.reload} />)}
            </div>}
      </ResourceBoundary>
    </OperationPage>
  );
}

function SpaceCard({ space, threads, reload }: { space: SpaceItem; threads: ThreadItem[]; reload(): Promise<void> }) {
  const [threadId, setThreadId] = useState(space.binding?.threadId ?? threads[0]?.threadId ?? "");
  const [mode, setMode] = useState<"exclusive" | "shared">(space.binding?.mode ?? "exclusive");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (mode === "shared" && !window.confirm("共享绑定会让多个会话共用同一线程上下文。确定继续吗？")) return;
    setPending(true);
    setNotice(null);
    try {
      await bindSpace(space.spaceId, threadId, mode);
      await reload();
      setNotice("绑定已更新");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <article className="record-card">
      <div className="record-card-heading">
        <div><h2>{space.displayName}</h2><p>{channelName(space.channel)} · {space.scope === "group" ? "群聊" : "私聊"} · {space.status}</p></div>
        <span className={`state-badge${space.binding?.mode === "shared" ? " state-badge-warning" : ""}`}>{space.binding ? `${space.binding.mode === "shared" ? "共享" : "独占"}绑定` : "未绑定"}</span>
      </div>
      <dl className="detail-grid">
        <div><dt>当前线程</dt><dd>{space.binding?.threadTitle ?? "暂无"}</dd></div>
        <div><dt>最近消息</dt><dd>{space.lastInboundAt ? formatDateTime(space.lastInboundAt) : "暂无"}</dd></div>
      </dl>
      <form className="inline-form" onSubmit={(event) => void submit(event)}>
        <label>目标线程<select name="threadId" required value={threadId} onChange={(event) => setThreadId(event.target.value)}>{threads.length === 0 ? <option value="">暂无可用线程</option> : threads.map((thread) => <option key={thread.threadId} value={thread.threadId}>{thread.title}</option>)}</select></label>
        <label>绑定模式<select name="mode" value={mode} onChange={(event) => setMode(event.target.value as "exclusive" | "shared")}><option value="exclusive">独占</option><option value="shared">共享（需确认）</option></select></label>
        <button className="button button-primary" type="submit" disabled={pending || !threadId}>{pending ? "正在绑定…" : "保存绑定"}</button>
        {space.binding ? <button className="button button-secondary" type="button" disabled={pending} onClick={() => {
          if (!window.confirm(`解除“${space.displayName}”的当前绑定吗？线程不会被删除。`)) return;
          setPending(true);
          void unbindSpace(space.spaceId).then(reload).then(() => setNotice("绑定已解除"), (error) => setNotice(errorMessage(error))).finally(() => setPending(false));
        }}>解除绑定</button> : null}
      </form>
      {notice ? <LiveNotice>{notice}</LiveNotice> : null}
      <details><summary>查看标识符</summary><code translate="no">{space.spaceId}</code>{space.binding ? <code translate="no">{space.binding.threadId}</code> : null}</details>
    </article>
  );
}

export function TasksPage() {
  const resource = useOperationResource(loadTasks);
  const [title, setTitle] = useState("");
  const [cwd, setCwd] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    setPending("create");
    try {
      await createThread({ ...(title.trim() ? { title: title.trim() } : {}), ...(cwd.trim() ? { cwd: cwd.trim() } : {}) });
      setTitle("");
      setCwd("");
      await resource.reload();
      setNotice("线程已创建");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setPending(null);
    }
  };

  return (
    <OperationPage title="线程与任务" description="查看 Codex 线程及 Turn 状态，并中断仍在运行的任务。">
      <form className="inline-form surface-form" onSubmit={(event) => void add(event)}>
        <label>线程标题<input name="title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如 项目排查…" /></label>
        <label>工作目录（可选）<input name="cwd" autoComplete="off" spellCheck={false} value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/path/to/project…" /></label>
        <button className="button button-primary" type="submit" disabled={pending !== null}>{pending === "create" ? "正在创建…" : "新建线程"}</button>
      </form>
      {notice ? <LiveNotice>{notice}</LiveNotice> : null}
      <ResourceBoundary resource={resource}>
        {(data) => <>
          <section className="section" aria-labelledby="active-turns-title"><h2 id="active-turns-title">Turn</h2>{data.turns.length === 0 ? <Empty title="暂无 Turn" detail="新任务开始后会显示排队、运行和终态。" /> : <DataTable headers={["状态", "线程", "传输", "时间", "操作"]}>{data.turns.map((turn) => <tr key={turn.turnId}><td><span className="state-badge">{turn.status}</span></td><td><code translate="no">{shortId(turn.threadId)}</code></td><td>{turn.transport}</td><td><time dateTime={turn.queuedAt}>{formatDateTime(turn.queuedAt)}</time></td><td>{["queued", "starting", "running", "unknown"].includes(turn.status) ? <button className="danger-link" type="button" disabled={pending !== null} onClick={() => { setPending(turn.turnId); void interruptTurn(turn.turnId).then(resource.reload).then(() => setNotice("Turn 已中断"), (error) => setNotice(errorMessage(error))).finally(() => setPending(null)); }}>{pending === turn.turnId ? "中断中…" : "中断"}</button> : "—"}</td></tr>)}</DataTable>}</section>
          <section className="section" aria-labelledby="threads-title"><h2 id="threads-title">Codex 线程</h2>{data.threads.length === 0 ? <Empty title="暂无线程" detail="可在上方创建第一个线程。" /> : <DataTable headers={["标题", "项目", "更新时间", "Thread ID"]}>{data.threads.map((thread) => <tr key={thread.threadId}><td><strong>{thread.title}</strong></td><td>{thread.projectName ?? "—"}</td><td>{thread.updatedAt ? formatDateTime(thread.updatedAt) : "—"}</td><td><code translate="no">{shortId(thread.threadId)}</code></td></tr>)}</DataTable>}</section>
        </>}
      </ResourceBoundary>
    </OperationPage>
  );
}

export function RouterPage() {
  const resource = useOperationResource(loadRouter);
  return <OperationPage title="智能调度" description="配置 Router、运行自然语言测试，并查看最近决策。"><ResourceBoundary resource={resource}>{(data) => <RouterPanel initial={data.config} decisions={data.decisions} reload={resource.reload} />}</ResourceBoundary></OperationPage>;
}

function RouterPanel({ initial, decisions, reload }: { initial: RouterConfig; decisions: Awaited<ReturnType<typeof loadRouter>>["decisions"]; reload(): Promise<void> }) {
  const [config, setConfig] = useState(initial);
  const [sample, setSample] = useState("切换到上一个项目线程");
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const set = <K extends keyof RouterConfig>(key: K, value: RouterConfig[K]) => setConfig((current) => ({ ...current, [key]: value }));

  return <>
    <form className="settings-form" onSubmit={(event) => { event.preventDefault(); setPending("save"); void updateRouter(config).then(reload).then(() => setNotice("Router 配置已应用"), (error) => setNotice(errorMessage(error))).finally(() => setPending(null)); }}>
      <label>模式<select name="mode" value={config.mode} onChange={(event) => set("mode", event.target.value as RouterConfig["mode"])}><option value="off">关闭</option><option value="assist">辅助</option><option value="auto">自动</option></select></label>
      <label>Endpoint<input name="baseUrl" type="url" autoComplete="off" spellCheck={false} value={config.baseUrl ?? ""} onChange={(event) => set("baseUrl", event.target.value || null)} placeholder="https://api.example.com/v1…" /></label>
      <label>Model<input name="model" autoComplete="off" spellCheck={false} value={config.model ?? ""} onChange={(event) => set("model", event.target.value || null)} /></label>
      <label>Secret Reference<input name="secretRef" autoComplete="off" spellCheck={false} value={config.secretRef ?? ""} onChange={(event) => set("secretRef", event.target.value || null)} placeholder="router/default…" /></label>
      <label>高置信阈值<input name="highConfidenceThreshold" type="number" min="0.9" max="1" step="0.01" value={config.highConfidenceThreshold} onChange={(event) => set("highConfidenceThreshold", Number(event.target.value))} /></label>
      <label>澄清阈值<input name="clarifyThreshold" type="number" min="0.5" max="0.89" step="0.01" value={config.clarifyThreshold} onChange={(event) => set("clarifyThreshold", Number(event.target.value))} /></label>
      <button className="button button-primary" type="submit" disabled={pending !== null}>{pending === "save" ? "正在应用…" : "保存并应用"}</button>
    </form>
    <form className="inline-form surface-form" onSubmit={(event) => { event.preventDefault(); setPending("test"); void testRouter(sample).then((result) => setNotice(`测试结果：${JSON.stringify(result)}`), (error) => setNotice(errorMessage(error))).finally(() => setPending(null)); }}>
      <label>测试语句<input name="sample" required value={sample} onChange={(event) => setSample(event.target.value)} /></label>
      <button className="button button-secondary" type="submit" disabled={pending !== null}>{pending === "test" ? "测试中…" : "测试判断"}</button>
    </form>
    {notice ? <LiveNotice>{notice}</LiveNotice> : null}
    <section className="section"><h2>最近决策</h2>{decisions.length === 0 ? <Empty title="暂无 Router 决策" detail="运行测试或收到控制意图后，决策会显示在这里。" /> : <DataTable headers={["类型", "置信度", "耗时", "结果", "时间"]}>{decisions.map((item) => <tr key={item.decisionId}><td>{item.decision.kind}</td><td>{Math.round(item.decision.confidence * 100)}%</td><td>{item.latencyMs} ms</td><td>{item.result ?? item.decision.clarification ?? "—"}</td><td>{formatDateTime(item.createdAt)}</td></tr>)}</DataTable>}</section>
  </>;
}

export function SettingsPage() {
  const resource = useOperationResource(loadSettings);
  return <OperationPage title="设置与诊断" description="修改运行与队列参数；成功只在新 Revision 实际生效后显示。"><ResourceBoundary resource={resource}>{(data) => <><SettingsPanel initial={data.config.value} revision={data.config.revision} reload={resource.reload} /><DiagnosticsPanel events={data.events} reload={resource.reload} /></>}</ResourceBoundary></OperationPage>;
}

function SettingsPanel({ initial, revision, reload }: { initial: VNextConfig; revision: string; reload(): Promise<void> }) {
  const [config, setConfig] = useState(initial);
  const [pending, setPending] = useState(false);
  const [plan, setPlan] = useState<ApplyPlan | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const queue = (key: keyof VNextConfig["queues"], value: number) => setConfig((current) => ({ ...current, queues: { ...current.queues, [key]: value } }));
  return <>
    <p className="revision-line">当前 Revision：<code translate="no">{shortId(revision)}</code></p>
    <dl className="detail-grid runtime-summary"><div><dt>监听地址</dt><dd><code translate="no">{config.runtime.listenHost}:{config.runtime.listenPort}</code></dd></div><div><dt>最大并行线程</dt><dd>{config.runtime.maxParallelThreads}</dd></div></dl>
    <form className="settings-form" onSubmit={(event) => { event.preventDefault(); setPending(true); setNotice(null); void planAndApplyConfig(config).then(async (nextPlan) => { setPlan(nextPlan); await reload(); setNotice(`配置已生效：${shortId(nextPlan.revision)}`); }, (error) => setNotice(errorMessage(error))).finally(() => setPending(false)); }}>
      <label>Space 队列上限<input name="spaceLimit" type="number" min="1" value={config.queues.spaceLimit} onChange={(event) => queue("spaceLimit", Number(event.target.value))} /></label>
      <label>Thread 队列上限<input name="threadLimit" type="number" min="1" value={config.queues.threadLimit} onChange={(event) => queue("threadLimit", Number(event.target.value))} /></label>
      <label>进度延迟（毫秒）<input name="progressDelayMs" type="number" min="0" value={config.queues.progressDelayMs} onChange={(event) => queue("progressDelayMs", Number(event.target.value))} /></label>
      <button className="button button-primary" type="submit" disabled={pending}>{pending ? "正在应用…" : "保存并应用"}</button>
    </form>
    {plan ? <div className="apply-plan"><strong>最近 Apply Plan</strong><span>{plan.effects.length === 0 ? "无需重启组件" : plan.effects.map((effect) => `${effect.type}${effect.component ? ` · ${effect.component}` : ""}`).join("；")}</span></div> : null}
    {notice ? <LiveNotice>{notice}</LiveNotice> : null}
  </>;
}

export function DiagnosticsPage() {
  const resource = useOperationResource(loadDiagnostics);
  return <OperationPage title="诊断" description="查看结构化运行事件，并导出不包含明文 Secret 的本地诊断包。"><ResourceBoundary resource={resource}>{(events) => <DiagnosticsPanel events={events} reload={resource.reload} />}</ResourceBoundary></OperationPage>;
}

function DiagnosticsPanel({ events, reload }: { events: DiagnosticEvent[]; reload(): Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  return <section className="section diagnostics-section" aria-labelledby="diagnostics-events-title">
    <div className="section-header"><h2 id="diagnostics-events-title">诊断与运行事件</h2><div className="heading-actions"><button className="button button-secondary" type="button" disabled={pending} onClick={() => { setPending(true); void exportDiagnostics(true).then((result) => setNotice(`诊断包已导出：${result.path}`), (error) => setNotice(errorMessage(error))).finally(() => setPending(false)); }}>{pending ? "正在导出…" : "导出诊断包"}</button><button className="button button-secondary" type="button" onClick={() => void reload()}>刷新</button></div></div>
    {notice ? <LiveNotice>{notice}</LiveNotice> : null}
    {events.length === 0 ? <Empty title="暂无运行事件" detail="组件状态、配置应用和 Turn 变化会记录在这里。" /> : <EventTable events={events} />}
  </section>;
}

function EventTable({ events }: { events: DiagnosticEvent[] }) {
  return <DataTable headers={["事件", "组件", "时间"]}>{events.map((event) => <tr key={event.eventId}><td><strong>{event.type}</strong></td><td>{event.component}</td><td><time dateTime={event.occurredAt}>{formatDateTime(event.occurredAt)}</time></td></tr>)}</DataTable>;
}

function OperationPage({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <div className="page page-operations"><div className="page-heading"><h1>{title}</h1><p>{description}</p></div>{children}</div>;
}

function ResourceBoundary<T>({ resource, children }: { resource: Resource<T>; children(data: T): ReactNode }) {
  if (resource.error && !resource.data) return <div className="load-error" role="alert"><div><strong>无法读取管理数据</strong><span>{resource.error.message}</span></div><button className="button button-secondary" type="button" onClick={() => void resource.reload()}>重试</button></div>;
  if (!resource.data) return <div className="empty-state" role="status">正在加载…</div>;
  return <>{resource.error ? <LiveNotice>刷新失败：{resource.error.message}</LiveNotice> : null}{children(resource.data)}</>;
}

type Resource<T> = { data: T | null; error: Error | null; loading: boolean; reload(): Promise<void> };
function useOperationResource<T>(loader: () => Promise<T>): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { setData(await loader()); } catch (cause) { setError(cause instanceof Error ? cause : new Error(String(cause))); } finally { setLoading(false); }
  }, [loader]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, loading, reload };
}

function DataTable({ headers, children }: { headers: string[]; children: ReactNode }) {
  return <div className="table-frame operation-table-frame"><table className="operation-table"><thead><tr>{headers.map((header) => <th scope="col" key={header}>{header}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
}

function Empty({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state" role="status"><strong>{title}</strong><span>{detail}</span></div>;
}

function LiveNotice({ children }: { children: ReactNode }) {
  return <div className="inline-notice" role="status" aria-live="polite">{children}</div>;
}

function channelName(channel: SpaceItem["channel"]): string { return { weixin: "微信", feishu: "飞书", qq: "QQ" }[channel]; }
function shortId(value: string): string { return value.length > 16 ? `${value.slice(0, 16)}…` : value; }
function formatDateTime(value: string): string { return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" }).format(new Date(value)); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
