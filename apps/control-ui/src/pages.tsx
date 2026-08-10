import { Link, isRouteErrorResponse, useRouteError } from "react-router";

export function OverviewPage() {
  return (
    <div className="page page-overview">
      <div className="page-heading">
        <h1>概览</h1>
      </div>
      <section className="section" aria-labelledby="system-status-title">
        <h2 id="system-status-title">系统状态</h2>
        <div className="status-band" aria-label="正在读取系统状态">
          <StatusPlaceholder tone="ready" label="连接管理服务" />
          <StatusPlaceholder tone="warning" label="读取组件状态" />
          <StatusPlaceholder tone="neutral" label="等待实时事件" />
        </div>
      </section>
      <section className="section" aria-labelledby="channel-status-title">
        <div className="section-header">
          <h2 id="channel-status-title">渠道状态</h2>
          <Link className="button button-primary" to="/channels">添加渠道</Link>
        </div>
        <div className="table-frame table-loading" role="status" aria-live="polite">
          <div className="table-header-row"><span>渠道</span><span>状态</span><span>最后活动</span><span>操作</span></div>
          <LoadingRow width="58%" />
          <LoadingRow width="44%" />
          <LoadingRow width="51%" />
        </div>
      </section>
      <section className="section" aria-labelledby="recent-activity-title">
        <h2 id="recent-activity-title">最近活动</h2>
        <div className="activity-loading" role="status" aria-label="正在读取最近活动">
          <LoadingLine width="72%" />
          <LoadingLine width="61%" />
          <LoadingLine width="68%" />
        </div>
        <Link className="button button-secondary diagnostics-link" to="/diagnostics">查看诊断</Link>
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
    : error instanceof Error ? error.message : "页面加载失败";
  return (
    <div className="route-error">
      <h1>无法打开页面</h1>
      <p>{message}</p>
      <Link className="button button-primary" to="/">返回概览</Link>
    </div>
  );
}

function StatusPlaceholder({ tone, label }: { tone: "ready" | "warning" | "neutral"; label: string }) {
  return (
    <div className="status-summary-item">
      <span className={`status-ring status-ring-${tone}`} aria-hidden="true" />
      <div>
        <strong>{label}</strong>
        <span>正在加载</span>
      </div>
    </div>
  );
}

function LoadingRow({ width }: { width: string }) {
  return (
    <div className="table-loading-row">
      <LoadingLine width={width} />
      <LoadingLine width="38%" />
      <LoadingLine width="54%" />
      <LoadingLine width="42%" />
    </div>
  );
}

function LoadingLine({ width }: { width: string }) {
  return <span className="loading-line" style={{ width }} aria-hidden="true" />;
}
