export const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>qq-codex-bridge 管理台</title>
  <style>
    :root {
      color-scheme: light;
      --page: #f4f5f2;
      --surface: #ffffff;
      --surface-2: #f9faf7;
      --ink: #1c211f;
      --ink-soft: #4b5551;
      --muted: #72807a;
      --line: #d9ded7;
      --line-strong: #bdc7bf;
      --green: #176b50;
      --green-2: #0f513d;
      --green-soft: #e5f1eb;
      --amber: #9d5b00;
      --amber-soft: #fff2d8;
      --red: #a83224;
      --red-soft: #fde8e4;
      --blue: #255f99;
      --blue-soft: #e7f0f8;
      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      --sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --shadow: 0 1px 2px rgba(28,33,31,.06), 0 16px 40px rgba(28,33,31,.06);
    }
    * { box-sizing: border-box; }
    html { min-width: 320px; background: var(--page); }
    body {
      min-height: 100vh; margin: 0; color: var(--ink);
      background: linear-gradient(180deg,rgba(23,107,80,.08),rgba(23,107,80,0) 260px),var(--page);
      font-family: var(--sans); font-size: 14px; letter-spacing: 0;
    }
    button,textarea,input,select { font: inherit; }
    button {
      min-height: 34px; border: 1px solid var(--line); border-radius: 6px;
      background: var(--surface); color: var(--ink); cursor: pointer;
    }
    button:hover { border-color: var(--line-strong); background: var(--surface-2); }
    button:focus-visible,textarea:focus-visible,input:focus-visible,select:focus-visible {
      outline: 3px solid rgba(23,107,80,.22); outline-offset: 2px;
    }
    button.primary { border-color: var(--green); background: var(--green); color: #fff; }
    button.primary:hover { background: var(--green-2); }

    .app-shell { display: grid; grid-template-columns: 220px minmax(0,1fr); min-height: 100vh; }
    .side {
      position: sticky; top: 0; height: 100vh; border-right: 1px solid var(--line);
      background: rgba(255,255,255,.82); backdrop-filter: blur(18px);
      padding: 20px 16px; display: flex; flex-direction: column; gap: 18px;
    }
    .brand { display: grid; gap: 6px; padding: 0 4px 12px; border-bottom: 1px solid var(--line); }
    .brand-mark {
      width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center;
      background: var(--ink); color: #fff; font: 700 12px/1 var(--mono);
    }
    .brand-title { margin: 0; font-size: 15px; line-height: 1.2; }
    .brand-subtitle { color: var(--muted); font-size: 11px; line-height: 1.4; }
    .nav { display: grid; gap: 3px; }
    .nav button {
      width: 100%; min-height: 36px; padding: 0 10px; border-color: transparent;
      background: transparent; text-align: left; color: var(--ink-soft); font-size: 13px;
    }
    .nav button.active {
      background: var(--green-soft); color: var(--green-2);
      border-color: rgba(23,107,80,.18); font-weight: 700;
    }
    .side-note {
      margin-top: auto; padding: 10px; border: 1px solid var(--line); border-radius: 8px;
      background: var(--surface-2); color: var(--muted); line-height: 1.55; font-size: 11px;
    }

    .content { min-width: 0; padding: 22px 24px; }
    .topbar { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 14px; align-items: start; margin-bottom: 16px; }
    .eyebrow { color: var(--green); font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; }
    h1 { margin: 4px 0 6px; font-size: clamp(22px,3vw,30px); line-height: 1.1; }
    .lead { max-width: 720px; margin: 0; color: var(--ink-soft); line-height: 1.6; font-size: 13px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .actions button { padding: 0 12px; }

    .health-strip { display: grid; grid-template-columns: minmax(190px,1.2fr) repeat(3,minmax(110px,1fr)); gap: 8px; margin-bottom: 16px; }
    .stat {
      min-height: 90px; border: 1px solid var(--line); border-radius: 8px;
      background: rgba(255,255,255,.78); box-shadow: var(--shadow);
      padding: 12px; display: grid; align-content: space-between; gap: 6px;
    }
    .stat.hero { background: var(--ink); color: #fff; }
    .stat-label { color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
    .stat.hero .stat-label { color: rgba(255,255,255,.5); }
    .stat-value { min-width: 0; font-size: 21px; line-height: 1; font-weight: 800; overflow-wrap: anywhere; }
    .stat-sub { color: var(--muted); font-size: 11px; line-height: 1.4; overflow-wrap: anywhere; }
    .stat.hero .stat-sub { color: rgba(255,255,255,.6); }

    .view { display: none; }
    .view.active { display: grid; gap: 14px; }
    .section-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .section-head h2 { margin: 0; font-size: 17px; }
    .section-head p { margin: 4px 0 0; color: var(--muted); font-size: 13px; line-height: 1.5; }

    .panel { border: 1px solid var(--line); border-radius: 8px; background: rgba(255,255,255,.82); box-shadow: var(--shadow); overflow: hidden; }
    .panel-body { padding: 16px; }
    .split { display: grid; grid-template-columns: minmax(0,.85fr) minmax(0,1.15fr); gap: 12px; }
    .summary-list { display: grid; gap: 0; }
    .summary-row { display: grid; grid-template-columns: 120px minmax(0,1fr); gap: 8px; padding: 7px 0; border-bottom: 1px solid var(--line); }
    .summary-row:last-child { border-bottom: 0; }
    .summary-row dt { color: var(--muted); font-size: 12px; }
    .summary-row dd { min-width: 0; margin: 0; overflow-wrap: anywhere; font-size: 13px; }

    .pill {
      display: inline-flex; align-items: center; gap: 5px; min-height: 20px;
      padding: 0 8px; border-radius: 999px; background: var(--green-soft);
      color: var(--green-2); font-size: 11px; font-weight: 750; white-space: nowrap;
    }
    .pill.error { background: var(--red-soft); color: var(--red); }
    .pill.warn { background: var(--amber-soft); color: var(--amber); }
    .pill.neutral { background: #ecefed; color: var(--ink-soft); }
    .pill.info { background: var(--blue-soft); color: var(--blue); }
    .dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; background: currentColor; }

    .code-box,textarea {
      width: 100%; margin: 0; border: 1px solid var(--line); border-radius: 8px;
      background: #fbfcf9; color: var(--ink); font: 12px/1.6 var(--mono);
      white-space: pre-wrap; overflow-wrap: anywhere;
    }
    .code-box { max-height: 460px; overflow: auto; padding: 12px; }
    textarea { min-height: 160px; resize: vertical; padding: 12px; }
    .field textarea { min-height: 110px; }
    #config-pending { min-height: 300px; }

    .empty { padding: 28px 16px; text-align: center; color: var(--muted); font-size: 13px; }
    .toast { color: var(--muted); font-size: 12px; line-height: 1.5; }
    .toast.error { color: var(--red); }
    .toolbar {
      display: flex; justify-content: space-between; align-items: center; gap: 10px;
      padding: 9px 14px; background: var(--surface-2); border-bottom: 1px solid var(--line);
    }
    .toolbar strong { font-size: 13px; }
    .toolbar .muted { color: var(--muted); font-size: 12px; }
    .loading { min-height: 160px; display: grid; place-items: center; color: var(--muted); font-size: 13px; }

    /* Sessions split layout */
    .sessions-layout { display: grid; grid-template-columns: 280px minmax(0,1fr); gap: 12px; align-items: start; }
    .session-list-panel {
      border: 1px solid var(--line); border-radius: 8px;
      background: rgba(255,255,255,.82); box-shadow: var(--shadow); overflow: hidden;
      position: sticky; top: 12px; max-height: calc(100vh - 180px); display: flex; flex-direction: column;
    }
    .session-list-scroll { overflow-y: auto; flex: 1; }
    .session-group-label {
      padding: 7px 12px 4px; font-size: 10px; font-weight: 800;
      text-transform: uppercase; letter-spacing: .07em; color: var(--muted);
      background: var(--surface-2); border-bottom: 1px solid var(--line);
      position: sticky; top: 0; z-index: 1;
    }
    .session-item {
      display: grid; gap: 3px; padding: 9px 12px;
      border-bottom: 1px solid var(--line); cursor: pointer; transition: background 100ms;
    }
    .session-item:last-child { border-bottom: 0; }
    .session-item:hover { background: var(--surface-2); }
    .session-item.selected { background: var(--green-soft); }
    .session-item-title {
      font-size: 13px; font-weight: 600; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; color: var(--ink);
    }
    .session-item.selected .session-item-title { color: var(--green-2); }
    .session-item-meta { display: flex; gap: 5px; align-items: center; font-size: 11px; color: var(--muted); }
    .session-item-error { color: var(--red); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    /* Thread panel */
    .thread-panel {
      border: 1px solid var(--line); border-radius: 8px;
      background: rgba(255,255,255,.82); box-shadow: var(--shadow);
      overflow: hidden; display: flex; flex-direction: column;
    }
    .thread-header {
      padding: 10px 16px; background: var(--surface-2); border-bottom: 1px solid var(--line);
      display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;
    }
    .thread-header-title { font-size: 14px; font-weight: 700; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .thread-header-meta { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .thread-empty { min-height: 260px; display: grid; place-items: center; color: var(--muted); font-size: 13px; }
    .timeline { padding: 14px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; max-height: calc(100vh - 240px); }

    /* Bubbles */
    .bubble-row { display: flex; gap: 8px; align-items: flex-end; }
    .bubble-row.inbound { flex-direction: row; }
    .bubble-row.outbound { flex-direction: row-reverse; }
    .bubble-avatar {
      width: 26px; height: 26px; border-radius: 50%; flex-shrink: 0;
      display: grid; place-items: center; font-size: 9px; font-weight: 800; color: #fff;
    }
    .bubble-avatar.in { background: var(--blue); }
    .bubble-avatar.out { background: var(--green); }
    .bubble-wrap { display: flex; flex-direction: column; gap: 4px; max-width: 70%; }
    .bubble-row.outbound .bubble-wrap { align-items: flex-end; }
    .bubble {
      padding: 9px 12px; border-radius: 12px; font-size: 13px; line-height: 1.65;
      color: var(--ink); white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word;
    }
    .bubble-row.inbound .bubble { background: #f0f2ef; border-bottom-left-radius: 4px; }
    .bubble-row.outbound .bubble { background: var(--green-soft); border-bottom-right-radius: 4px; }
    .bubble-meta { display: flex; gap: 5px; align-items: center; font-size: 11px; color: var(--muted); }
    .bubble-row.outbound .bubble-meta { justify-content: flex-end; }
    .bubble-media { display: grid; gap: 5px; margin-top: 5px; }
    .media-card { border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); overflow: hidden; }
    .media-thumb { min-height: 70px; display: grid; place-items: center; background: #eef2ee; color: var(--muted); font: 700 11px/1.3 var(--mono); text-align: center; padding: 8px; }
    .media-thumb img { width: 100%; max-height: 260px; object-fit: cover; display: block; }
    .media-body { padding: 7px; font-size: 11px; color: var(--ink-soft); display: grid; gap: 3px; }

    /* Error cards */
    .card-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(240px,1fr)); gap: 10px; padding: 12px; }
    .record-card { min-width: 0; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); padding: 12px; display: grid; gap: 8px; }
    .record-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
    .record-title { min-width: 0; margin: 0; font-size: 13px; line-height: 1.35; overflow-wrap: anywhere; }
    .record-meta { display: flex; gap: 5px; flex-wrap: wrap; font-size: 11px; color: var(--muted); }

    /* Config */
    .config-notice {
      display: flex; align-items: flex-start; gap: 10px; padding: 10px 14px; border-radius: 8px;
      background: var(--amber-soft); border: 1px solid rgba(157,91,0,.2); color: var(--amber);
      font-size: 13px; line-height: 1.5;
    }
    .config-notice strong { font-weight: 700; }
    .form-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px; }
    .channel-add-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px; margin-bottom: 14px; }
    .form-section { border: 1px solid var(--line); border-radius: 8px; background: var(--surface); padding: 13px; display: grid; gap: 9px; }
    .form-section.full { grid-column: 1 / -1; }
    .form-section h3 { margin: 0; font-size: 13px; font-weight: 700; }
    .field { display: grid; gap: 4px; }
    .field label { color: var(--ink-soft); font-size: 12px; font-weight: 700; }
    .field input,.field select { width: 100%; min-height: 36px; border: 1px solid var(--line); border-radius: 6px; background: #fbfcf9; color: var(--ink); padding: 0 9px; }
    .field.inline { display: flex; align-items: center; min-height: 34px; }
    .field.inline label { display: flex; align-items: center; gap: 7px; font-size: 13px; }
    .field.inline input { width: 16px; height: 16px; min-height: 16px; padding: 0; }
    .json-details summary { cursor: pointer; color: var(--ink-soft); font-weight: 700; font-size: 13px; margin-bottom: 7px; }

    @media (max-width: 1080px) { .sessions-layout { grid-template-columns: 250px minmax(0,1fr); } }
    @media (max-width: 940px) {
      .app-shell { grid-template-columns: 1fr; }
      .side { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); }
      .nav { display: flex; overflow-x: auto; padding-bottom: 2px; gap: 4px; }
      .nav button { width: auto; white-space: nowrap; }
      .side-note { display: none; }
      .health-strip { grid-template-columns: repeat(2,minmax(0,1fr)); }
      .split,.form-grid,.channel-add-grid { grid-template-columns: 1fr; }
      .form-section.full { grid-column: auto; }
      .sessions-layout { grid-template-columns: 1fr; }
      .session-list-panel { position: static; max-height: 280px; }
      .timeline { max-height: 500px; }
    }
    @media (max-width: 580px) {
      body { font-size: 15px; } .content { padding: 12px 14px; }
      .topbar { grid-template-columns: 1fr; } .actions { justify-content: flex-start; }
      .health-strip { grid-template-columns: 1fr; } h1 { font-size: 22px; }
      .summary-row { grid-template-columns: 1fr; gap: 2px; }
      .bubble-wrap { max-width: 86%; }
    }
    @media (prefers-reduced-motion: no-preference) {
      .view.active { animation: viewIn 130ms ease-out; }
      @keyframes viewIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }
    }
  </style>
</head>
<body>
  <div class="app-shell">
    <aside class="side">
      <div class="brand">
        <div class="brand-mark">QB</div>
        <h1 class="brand-title">qq-codex-bridge</h1>
        <div class="brand-subtitle">本地桥接运行台</div>
      </div>
      <nav class="nav" aria-label="管理台导航">
        <button class="active" data-view="status">运行总览</button>
        <button data-view="sessions">会话 &amp; 消息</button>
        <button data-view="errors">错误日志</button>
        <button data-view="config">配置</button>
      </nav>
      <div class="side-note" id="side-note">仅允许本机访问。保存的配置在重启服务后生效。</div>
    </aside>

    <main class="content">
      <div class="topbar">
        <div>
          <div class="eyebrow">Local Admin</div>
          <h1 id="page-title">运行总览</h1>
          <p class="lead" id="page-description">正在读取桥接服务状态、通道和最近事件。</p>
        </div>
        <div class="actions">
          <button id="copy-url">复制地址</button>
          <button class="primary" id="refresh">刷新</button>
        </div>
      </div>

      <section class="health-strip" aria-label="关键状态">
        <div class="stat hero">
          <div class="stat-label">管理台地址</div>
          <div class="stat-value" id="metric-admin-url">读取中</div>
          <div class="stat-sub">以启动日志中的端口为准</div>
        </div>
        <div class="stat">
          <div class="stat-label">活跃通道</div>
          <div class="stat-value" id="metric-channels">0</div>
          <div class="stat-sub" id="metric-channel-list">暂无</div>
        </div>
        <div class="stat">
          <div class="stat-label">待投递</div>
          <div class="stat-value" id="metric-pending">0</div>
          <div class="stat-sub">delivery_jobs pending</div>
        </div>
        <div class="stat">
          <div class="stat-label">错误事件</div>
          <div class="stat-value" id="metric-errors">0</div>
          <div class="stat-sub">runtime_events error</div>
        </div>
      </section>

      <!-- 运行总览 -->
      <section class="view active" id="view-status">
        <div class="section-head">
          <div><h2>服务健康</h2><p>端口、通道、数据目录和配置完整性一览。</p></div>
        </div>
        <div class="split">
          <div class="panel">
            <div class="toolbar"><strong>运行摘要</strong><span class="muted" id="status-updated">未刷新</span></div>
            <div class="panel-body"><dl class="summary-list" id="runtime-summary"></dl></div>
          </div>
          <div class="panel">
            <div class="toolbar"><strong>原始状态 JSON</strong><span class="muted">只读</span></div>
            <div class="panel-body"><pre class="code-box" id="status-json"></pre></div>
          </div>
        </div>
      </section>

      <!-- 会话 & 消息 -->
      <section class="view" id="view-sessions">
        <div class="section-head">
          <div><h2>会话 &amp; 消息</h2><p>左侧按渠道浏览所有会话线程，右侧查看完整进站和出站消息时间线。</p></div>
          <span class="pill neutral" id="session-count">0 条</span>
        </div>
        <div class="sessions-layout">
          <div class="session-list-panel">
            <div class="toolbar"><strong>会话列表</strong><span class="muted" id="session-list-hint">按渠道分组</span></div>
            <div class="session-list-scroll" id="session-list"><div class="loading">读取会话中</div></div>
          </div>
          <div class="thread-panel" id="thread-panel">
            <div class="thread-empty">← 点击左侧会话查看对话记录</div>
          </div>
        </div>
      </section>

      <!-- 错误日志 -->
      <section class="view" id="view-errors">
        <div class="section-head">
          <div><h2>错误日志</h2><p>运行事件与投递错误分开展示，便于定位问题。</p></div>
          <span class="pill neutral" id="error-count">0 条</span>
        </div>
        <div class="split">
          <div class="panel">
            <div class="toolbar"><strong>运行事件</strong><span class="muted">runtime_events</span></div>
            <div id="events-table" class="loading">读取事件中</div>
          </div>
          <div class="panel">
            <div class="toolbar"><strong>投递错误</strong><span class="muted">delivery_jobs.last_error</span></div>
            <div id="delivery-errors-table" class="loading">读取投递错误中</div>
          </div>
        </div>
      </section>

      <!-- 配置 -->
      <section class="view" id="view-config">
        <div class="section-head">
          <div><h2>配置</h2><p>修改后点击「保存配置」，重启服务后生效。</p></div>
        </div>
        <div class="config-notice">
          <strong>⚠ 注意：</strong>&nbsp;此处保存的配置需要重启服务才能生效。当前运行中的服务仍使用启动时加载的配置。
        </div>
        <div class="panel">
          <div class="toolbar"><strong>快速添加渠道账号</strong><span class="muted">填写后点「添加账号」追加到下方 JSON 列表</span></div>
          <div class="panel-body">
            <div class="channel-add-grid">
              <section class="form-section">
                <h3>新增 QQ Bot</h3>
                <div class="field">
                  <label for="new-qq-account-id">账号 ID</label>
                  <input id="new-qq-account-id" autocomplete="off" placeholder="main / shop / support">
                </div>
                <div class="field">
                  <label for="new-qq-app-id">App ID</label>
                  <input id="new-qq-app-id" autocomplete="off">
                </div>
                <div class="field">
                  <label for="new-qq-secret">Client Secret</label>
                  <input id="new-qq-secret" autocomplete="off">
                </div>
                <div class="field inline">
                  <label><input id="new-qq-markdown" type="checkbox">启用 Markdown</label>
                </div>
                <button id="add-qq-channel" type="button">添加账号</button>
              </section>
              <section class="form-section">
                <h3>新增微信接入</h3>
                <div class="field">
                  <label for="new-weixin-account-id">账号 ID</label>
                  <input id="new-weixin-account-id" autocomplete="off" placeholder="default / work / shop">
                </div>
                <div class="field">
                  <label for="new-weixin-webhook">Webhook 路径</label>
                  <input id="new-weixin-webhook" autocomplete="off" placeholder="/webhooks/weixin/work">
                </div>
                <div class="field">
                  <label for="new-weixin-egress">Egress Base URL</label>
                  <input id="new-weixin-egress" autocomplete="off" placeholder="http://127.0.0.1:3201">
                </div>
                <div class="field">
                  <label for="new-weixin-token">Egress Token</label>
                  <input id="new-weixin-token" autocomplete="off">
                </div>
                <button id="add-weixin-channel" type="button">添加账号</button>
              </section>
            </div>

            <form id="config-form" class="form-grid">
              <section class="form-section">
                <h3>运行时</h3>
                <div class="field">
                  <label for="config-database-path">SQLite 数据库路径</label>
                  <input id="config-database-path" name="databasePath" autocomplete="off">
                </div>
                <div class="field">
                  <label for="config-listen-host">监听 Host</label>
                  <input id="config-listen-host" name="runtime.listenHost" autocomplete="off">
                </div>
                <div class="field">
                  <label for="config-listen-port">监听端口</label>
                  <input id="config-listen-port" name="runtime.listenPort" inputmode="numeric">
                </div>
                <div class="field">
                  <label for="config-webhook-path">QQ Webhook 路径</label>
                  <input id="config-webhook-path" name="runtime.webhookPath" autocomplete="off">
                </div>
              </section>
              <section class="form-section">
                <h3>桌面端</h3>
                <div class="field">
                  <label for="config-provider">默认模型源</label>
                  <select id="config-provider" name="conversationProvider">
                    <option value="codex-desktop">Codex Desktop</option>
                    <option value="chatgpt-desktop">ChatGPT Desktop</option>
                  </select>
                </div>
                <div class="field">
                  <label for="config-codex-app-name">Codex 应用名</label>
                  <input id="config-codex-app-name" name="codexDesktop.appName" autocomplete="off">
                </div>
                <div class="field">
                  <label for="config-codex-port">Codex Remote Debugging 端口</label>
                  <input id="config-codex-port" name="codexDesktop.remoteDebuggingPort" inputmode="numeric">
                </div>
              </section>
              <section class="form-section">
                <h3>QQ Bot 主账号</h3>
                <div class="field">
                  <label for="config-qq-account-id">账号 ID</label>
                  <input id="config-qq-account-id" name="qqBot.accountId" autocomplete="off">
                </div>
                <div class="field">
                  <label for="config-qq-app-id">App ID</label>
                  <input id="config-qq-app-id" name="qqBot.appId" autocomplete="off">
                </div>
                <div class="field">
                  <label for="config-qq-secret">Client Secret</label>
                  <input id="config-qq-secret" name="qqBot.clientSecret" autocomplete="off">
                </div>
                <div class="field inline">
                  <label><input id="config-qq-markdown" name="qqBot.markdownSupport" type="checkbox">启用 QQ Markdown</label>
                </div>
              </section>
              <section class="form-section">
                <h3>微信主账号</h3>
                <div class="field inline">
                  <label><input id="config-weixin-enabled" name="weixin.enabled" type="checkbox">启用微信通道</label>
                </div>
                <div class="field">
                  <label for="config-weixin-account-id">账号 ID</label>
                  <input id="config-weixin-account-id" name="weixin.accountId" autocomplete="off">
                </div>
                <div class="field">
                  <label for="config-weixin-webhook">Webhook 路径</label>
                  <input id="config-weixin-webhook" name="weixin.webhookPath" autocomplete="off">
                </div>
                <div class="field">
                  <label for="config-weixin-egress">Egress Base URL</label>
                  <input id="config-weixin-egress" name="weixin.egressBaseUrl" autocomplete="off">
                </div>
                <div class="field">
                  <label for="config-weixin-token">Egress Token</label>
                  <input id="config-weixin-token" name="weixin.egressToken" autocomplete="off">
                </div>
              </section>
              <section class="form-section full">
                <h3>多账号 JSON（直接编辑）</h3>
                <div class="field">
                  <label for="config-qqbots-json">QQ Bots 列表</label>
                  <textarea id="config-qqbots-json" name="qqBotsJson" spellcheck="false"></textarea>
                </div>
                <div class="field">
                  <label for="config-weixin-json">微信账号列表</label>
                  <textarea id="config-weixin-json" name="weixinAccountsJson" spellcheck="false"></textarea>
                </div>
              </section>
            </form>

            <div style="display:flex;gap:8px;align-items:center;margin-top:14px;flex-wrap:wrap;border-top:1px solid var(--line);padding-top:14px;">
              <button class="primary" id="save-config">保存配置（重启后生效）</button>
              <button id="reset-config">恢复当前运行配置</button>
              <span class="toast" id="config-save-result"></span>
            </div>
            <details class="json-details" style="margin-top:12px;">
              <summary>查看完整待保存 JSON</summary>
              <textarea id="config-pending" spellcheck="false"></textarea>
            </details>
          </div>
        </div>
      </section>
    </main>
  </div>

  <script>
    const state = {};
    const keepSecretValue = "__QQ_CODEX_KEEP_SECRET__";
    const pageMeta = {
      status:   ["运行总览",    "正在读取桥接服务状态、通道和最近事件。"],
      sessions: ["会话 & 消息", "左侧按渠道浏览所有会话线程，右侧查看完整对话时间线。"],
      errors:   ["错误日志",    "运行事件与投递错误分开展示，便于定位问题。"],
      config:   ["配置",        "修改后点击「保存配置」，重启服务后生效。"]
    };

    const tabs = document.querySelectorAll("[data-view]");
    for (const tab of tabs) tab.addEventListener("click", () => activateView(tab.dataset.view));
    document.querySelector("#refresh").addEventListener("click", loadAll);
    document.querySelector("#copy-url").addEventListener("click", copyAdminUrl);
    document.querySelector("#save-config").addEventListener("click", saveConfig);
    document.querySelector("#reset-config").addEventListener("click", resetConfigDraft);
    document.querySelector("#config-form").addEventListener("input", syncPendingFromForm);
    document.querySelector("#add-qq-channel").addEventListener("click", addQqChannel);
    document.querySelector("#add-weixin-channel").addEventListener("click", addWeixinChannel);

    function activateView(name) {
      for (const item of tabs) item.classList.toggle("active", item.dataset.view === name);
      for (const view of document.querySelectorAll(".view")) view.classList.remove("active");
      document.querySelector("#view-" + name).classList.add("active");
      const meta = pageMeta[name] || pageMeta.status;
      document.querySelector("#page-title").textContent = meta[0];
      document.querySelector("#page-description").textContent = meta[1];
      history.replaceState(null, "", "#/" + name);
    }

    async function api(path, options) {
      const response = await fetch(path, options);
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }

    async function loadAll() {
      setLoading(true);
      try {
        const [status, sessions, messages, errors, config] = await Promise.all([
          api("/admin/api/status"),
          api("/admin/api/sessions?limit=200"),
          api("/admin/api/messages?limit=200"),
          api("/admin/api/errors?limit=100"),
          api("/admin/api/config")
        ]);
        Object.assign(state, { status, sessions, messages, errors, config });
        renderStatus(status);
        renderSessionsView(sessions.sessions, messages.messages);
        renderErrors(errors);
        renderConfig(config);
      } catch (error) {
        renderLoadError(error);
      } finally {
        setLoading(false);
      }
    }

    /* ── Status ── */
    function renderStatus(data) {
      const adminUrl = data.adminUrl || ("http://" + data.listenHost + ":" + data.listenPort + "/admin");
      document.querySelector("#metric-admin-url").textContent = adminUrl;
      document.querySelector("#metric-channels").textContent = number(data.channels.length);
      document.querySelector("#metric-channel-list").textContent = data.channels.length ? data.channels.join(" / ") : "暂无通道";
      document.querySelector("#metric-pending").textContent = number(data.stats.pendingDeliveryCount);
      document.querySelector("#metric-errors").textContent = number(data.stats.errorEventCount);
      document.querySelector("#status-updated").textContent = "刷新于 " + time(data.now);
      document.querySelector("#runtime-summary").innerHTML = summaryRows([
        ["监听地址", data.listenHost + ":" + data.listenPort],
        ["管理台", adminUrl],
        ["Webhook", data.webhookPath],
        ["默认模型源", data.conversationProvider],
        ["数据文件", data.databasePath],
        ["配置完整", data.configComplete ? "是" : "否"],
        ["启动时间", dateTime(data.startedAt)],
        ["运行时长", duration(data.uptimeMs)]
      ]);
      document.querySelector("#status-json").textContent = JSON.stringify(data, null, 2);
    }

    /* ── Sessions & Messages ── */
    function renderSessionsView(sessions, messages) {
      document.querySelector("#session-count").textContent = number(sessions.length) + " 条";

      // Build message index keyed by sessionKey
      const msgsBySession = {};
      for (const m of messages) {
        if (!msgsBySession[m.sessionKey]) msgsBySession[m.sessionKey] = [];
        msgsBySession[m.sessionKey].push(m);
      }
      // Sort each session's messages oldest-first for timeline display
      for (const k of Object.keys(msgsBySession)) {
        msgsBySession[k].sort((a, b) => (a.createdAt || "") < (b.createdAt || "") ? -1 : 1);
      }
      state._msgsBySession = msgsBySession;

      if (!sessions.length) {
        document.querySelector("#session-list").innerHTML = '<div class="empty">暂无会话。收到第一条消息后这里会出现记录。</div>';
        document.querySelector("#thread-panel").innerHTML = '<div class="thread-empty">暂无会话数据。</div>';
        return;
      }

      // Group by accountKey (channel)
      const groups = {};
      for (const s of sessions) {
        const channelKey = s.accountKey || "未知渠道";
        if (!groups[channelKey]) groups[channelKey] = [];
        groups[channelKey].push(s);
      }

      let listHtml = "";
      for (const [channelKey, rows] of Object.entries(groups)) {
        listHtml += '<div class="session-group-label">' + escapeHtml(channelKey) + '</div>';
        for (const row of rows) {
          const msgCount = (msgsBySession[row.sessionKey] || []).length;
          const lastTime = compactDate(row.lastInboundAt || row.lastOutboundAt);
          listHtml += '<div class="session-item" data-session-key="' + escapeHtml(row.sessionKey) + '">' +
            '<div class="session-item-title">' + escapeHtml(row.peerKey || row.peerId || row.sessionKey) + '</div>' +
            '<div class="session-item-meta">' +
              '<span class="pill ' + (row.chatType === "group" ? "info" : "neutral") +
                '" style="font-size:10px;min-height:17px;padding:0 5px;">' + escapeHtml(row.chatType || "private") + '</span>' +
              '<span>' + escapeHtml(lastTime) + '</span>' +
              (msgCount ? '<span>' + msgCount + ' 条消息</span>' : '') +
            '</div>' +
            (row.lastError ? '<div class="session-item-error">⚠ ' + escapeHtml(clip(row.lastError, 55)) + '</div>' : '') +
          '</div>';
        }
      }
      document.querySelector("#session-list").innerHTML = listHtml;

      for (const item of document.querySelectorAll(".session-item")) {
        item.addEventListener("click", () => {
          for (const el of document.querySelectorAll(".session-item")) el.classList.remove("selected");
          item.classList.add("selected");
          const key = item.dataset.sessionKey;
          const session = sessions.find(s => s.sessionKey === key);
          renderThreadPanel(session, state._msgsBySession[key] || []);
        });
      }

      // Auto-select first
      const first = document.querySelector(".session-item");
      if (first) first.click();
    }

    function renderThreadPanel(session, msgs) {
      if (!session) { document.querySelector("#thread-panel").innerHTML = '<div class="thread-empty">未找到会话信息。</div>'; return; }
      const inCount = msgs.filter(m => m.direction === "inbound").length;
      const outCount = msgs.filter(m => m.direction !== "inbound").length;
      let html = '<div class="thread-header">' +
        '<div class="thread-header-title">' + escapeHtml(session.peerKey || session.peerId || session.sessionKey) + '</div>' +
        '<div class="thread-header-meta">' +
          cellHtml(pill(session.chatType || "private", session.chatType === "group" ? "info" : "neutral")) +
          cellHtml(pill(session.status || "unknown", session.status === "active" ? undefined : "warn")) +
          cellHtml(pill("↓ " + inCount + "  ↑ " + outCount, "neutral")) +
          (session.codexThreadRef ? cellHtml(mono(session.codexThreadRef)) : "") +
        '</div>' +
      '</div>';

      if (!msgs.length) {
        html += '<div class="thread-empty">该会话暂无消息记录。</div>';
      } else {
        html += '<div class="timeline">';
        for (const m of msgs) {
          const isIn = m.direction === "inbound";
          const text = cleanMessageText(m.text || "");
          const media = [...(m.mediaArtifacts || []), ...(m.mediaReferences || []).map(referenceToArtifact)];
          html += '<div class="bubble-row ' + (isIn ? "inbound" : "outbound") + '">' +
            '<div class="bubble-avatar ' + (isIn ? "in" : "out") + '">' + (isIn ? "IN" : "OUT") + '</div>' +
            '<div class="bubble-wrap">' +
              '<div class="bubble">' + (text ? escapeHtml(text) : '<span style="color:var(--muted);font-style:italic;">（无文本）</span>') + '</div>' +
              (media.length ? '<div class="bubble-media">' + media.map(renderMediaCard).join("") + '</div>' : "") +
              '<div class="bubble-meta">' +
                '<span>' + escapeHtml(compactDate(m.createdAt)) + '</span>' +
                (m.status ? cellHtml(pill(m.status, m.status === "pending" ? "warn" : "neutral")) : "") +
                (m.lastError ? '<span style="color:var(--red);">' + escapeHtml(clip(m.lastError, 60)) + '</span>' : "") +
              '</div>' +
            '</div>' +
          '</div>';
        }
        html += '</div>';
      }

      document.querySelector("#thread-panel").outerHTML = '<div class="thread-panel" id="thread-panel">' + html + '</div>';

      // Scroll timeline to bottom
      const timeline = document.querySelector(".timeline");
      if (timeline) timeline.scrollTop = timeline.scrollHeight;
    }

    /* ── Errors ── */
    function renderErrors(data) {
      const total = data.events.length + data.deliveryErrors.length;
      document.querySelector("#error-count").textContent = number(total) + " 条";
      document.querySelector("#events-table").outerHTML =
        '<div id="events-table">' + cardGrid(data.events, renderEventCard, "暂无运行事件。") + '</div>';
      document.querySelector("#delivery-errors-table").outerHTML =
        '<div id="delivery-errors-table">' + cardGrid(data.deliveryErrors, renderDeliveryErrorCard, "暂无投递错误。") + '</div>';
    }

    /* ── Config ── */
    function renderConfig(data) {
      const effective = data.effective || {};
      const saved = data.draft || data.effective;
      fillConfigForm(saved || effective);
      document.querySelector("#config-pending").value = JSON.stringify(buildConfigFromForm(), null, 2);
    }

    async function saveConfig() {
      const result = document.querySelector("#config-save-result");
      result.classList.remove("error");
      try {
        const useJson = document.querySelector(".json-details").open;
        const value = useJson ? JSON.parse(document.querySelector("#config-pending").value) : buildConfigFromForm();
        await api("/admin/api/config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(value)
        });
        result.textContent = "已保存。重启服务后生效。";
        await loadAll();
      } catch (error) {
        result.classList.add("error");
        result.textContent = error instanceof Error ? error.message : String(error);
      }
    }

    function resetConfigDraft() {
      if (!state.config) return;
      fillConfigForm(state.config.effective);
      document.querySelector("#config-pending").value = JSON.stringify(state.config.effective, null, 2);
      const result = document.querySelector("#config-save-result");
      result.classList.remove("error");
      result.textContent = "已恢复为当前运行配置，尚未保存。";
    }

    async function copyAdminUrl() {
      const url = state.status?.adminUrl || location.href;
      try {
        await navigator.clipboard.writeText(url);
        document.querySelector("#copy-url").textContent = "已复制";
        setTimeout(() => { document.querySelector("#copy-url").textContent = "复制地址"; }, 1200);
      } catch { location.hash = location.hash; }
    }

    function cardGrid(rows, renderer, emptyText) {
      if (!rows.length) return '<div class="empty">' + escapeHtml(emptyText) + '</div>';
      return '<div class="card-grid">' + rows.map(renderer).join("") + '</div>';
    }

    function renderEventCard(row) {
      return '<article class="record-card">' +
        '<div class="record-head"><h3 class="record-title">' + escapeHtml(row.message) + '</h3>' + cellHtml(pill(row.level, row.level)) + '</div>' +
        '<dl class="summary-list">' + summaryRows([
          ["来源", row.source],
          ["时间", compactDate(row.createdAt)],
          ["详情", row.details ? mono(JSON.stringify(row.details)) : muted("无")]
        ]) + '</dl></article>';
    }

    function renderDeliveryErrorCard(row) {
      return '<article class="record-card">' +
        '<div class="record-head"><h3 class="record-title">' + escapeHtml(row.lastError) + '</h3>' + cellHtml(pill(row.status, "warn")) + '</div>' +
        '<dl class="summary-list">' + summaryRows([
          ["任务", mono(row.jobId)],
          ["会话", mono(row.sessionKey)],
          ["时间", compactDate(row.updatedAt)]
        ]) + '</dl></article>';
    }

    function renderMediaCard(item) {
      const name = item.originalName || basename(item.localPath || item.sourceUrl) || item.kind || "media";
      const url = mediaPreviewUrl(item);
      const canPreview = item.kind === "image" && Boolean(url);
      return '<div class="media-card">' +
        '<div class="media-thumb">' + (canPreview
          ? '<img alt="' + escapeHtml(name) + '" src="' + escapeHtml(url) + '" loading="lazy">'
          : escapeHtml(mediaLabel(item))) + '</div>' +
        '<div class="media-body">' +
          '<strong>' + escapeHtml(name) + '</strong>' +
          '<span>' + escapeHtml(item.mimeType || item.kind || "unknown") + ' · ' + escapeHtml(fileSize(item.fileSize)) + '</span>' +
          (item.localPath ? '<span>' + cellHtml(mono(item.localPath)) + '</span>' : "") +
          (item.sourceUrl ? '<span>' + cellHtml(mono(item.sourceUrl)) + '</span>' : "") +
          (item.transcript ? '<span>转写：' + escapeHtml(item.transcript) + '</span>' : "") +
          (item.extractedText ? '<span>提取文本：' + escapeHtml(clip(item.extractedText, 100)) + '</span>' : "") +
        '</div></div>';
    }

    /* ── Config form helpers ── */
    function fillConfigForm(config) {
      const qqBot = config.qqBot || (Array.isArray(config.qqBots) ? config.qqBots[0] : {}) || {};
      const weixin = config.weixin || (Array.isArray(config.weixinAccounts) ? config.weixinAccounts[0] : {}) || {};
      setField("config-database-path", config.databasePath);
      setField("config-listen-host", config.runtime?.listenHost);
      setField("config-listen-port", config.runtime?.listenPort);
      setField("config-webhook-path", config.runtime?.webhookPath);
      setField("config-provider", config.conversationProvider);
      setField("config-codex-app-name", config.codexDesktop?.appName);
      setField("config-codex-port", config.codexDesktop?.remoteDebuggingPort);
      setField("config-qq-account-id", qqBot.accountId);
      setField("config-qq-app-id", qqBot.appId);
      setSecretField("config-qq-secret", qqBot.clientSecret);
      setChecked("config-qq-markdown", Boolean(qqBot.markdownSupport));
      setChecked("config-weixin-enabled", Boolean(weixin.enabled));
      setField("config-weixin-account-id", weixin.accountId);
      setField("config-weixin-webhook", weixin.webhookPath);
      setField("config-weixin-egress", weixin.egressBaseUrl);
      setSecretField("config-weixin-token", weixin.egressToken);
      setField("config-qqbots-json", JSON.stringify(prepareSecretsForForm(config.qqBots || [qqBot]), null, 2));
      setField("config-weixin-json", JSON.stringify(prepareSecretsForForm(config.weixinAccounts || (weixin.enabled ? [weixin] : [])), null, 2));
    }

    function buildConfigFromForm() {
      const qqBot = {
        accountId: value("config-qq-account-id") || "default",
        appId: value("config-qq-app-id"),
        clientSecret: secretValue("config-qq-secret"),
        markdownSupport: checked("config-qq-markdown"),
        stt: null
      };
      const weixin = {
        enabled: checked("config-weixin-enabled"),
        accountId: value("config-weixin-account-id") || "default",
        webhookPath: value("config-weixin-webhook") || "/webhooks/weixin",
        egressBaseUrl: nullable(value("config-weixin-egress")),
        egressToken: nullable(secretValue("config-weixin-token"))
      };
      return {
        databasePath: value("config-database-path") || "runtime/qq-codex-bridge.sqlite",
        runtime: {
          listenHost: value("config-listen-host") || "127.0.0.1",
          listenPort: numberValue("config-listen-port", 3100),
          webhookPath: value("config-webhook-path") || "/webhooks/qq"
        },
        qqBot,
        qqBots: parseJsonField("config-qqbots-json", [qqBot]),
        weixin,
        weixinAccounts: parseJsonField("config-weixin-json", weixin.enabled ? [weixin] : []),
        codexDesktop: {
          appName: value("config-codex-app-name") || "Codex",
          remoteDebuggingPort: numberValue("config-codex-port", 9229)
        },
        conversationProvider: value("config-provider") || "codex-desktop"
      };
    }

    function syncPendingFromForm() {
      try { document.querySelector("#config-pending").value = JSON.stringify(buildConfigFromForm(), null, 2); } catch { /* ok */ }
    }

    function addQqChannel() {
      const accountId = value("new-qq-account-id") || "bot" + (currentArray("config-qqbots-json").length + 1);
      setField("config-qqbots-json", JSON.stringify([
        ...currentArray("config-qqbots-json"),
        { accountId, appId: value("new-qq-app-id"), clientSecret: value("new-qq-secret"), markdownSupport: checked("new-qq-markdown"), stt: null }
      ], null, 2));
      setField("new-qq-account-id", ""); setField("new-qq-app-id", ""); setField("new-qq-secret", ""); setChecked("new-qq-markdown", false);
      syncPendingFromForm();
      showConfigToast("已添加 QQ Bot：" + accountId);
    }

    function addWeixinChannel() {
      const accountId = value("new-weixin-account-id") || "account" + (currentArray("config-weixin-json").length + 1);
      setField("config-weixin-json", JSON.stringify([
        ...currentArray("config-weixin-json"),
        { enabled: true, accountId, webhookPath: value("new-weixin-webhook") || "/webhooks/weixin/" + accountId, egressBaseUrl: nullable(value("new-weixin-egress")), egressToken: nullable(value("new-weixin-token")) }
      ], null, 2));
      setField("new-weixin-account-id", ""); setField("new-weixin-webhook", ""); setField("new-weixin-egress", ""); setField("new-weixin-token", "");
      syncPendingFromForm();
      showConfigToast("已添加微信账号：" + accountId);
    }

    function currentArray(id) {
      try { const p = JSON.parse(value(id) || "[]"); return Array.isArray(p) ? p : []; } catch { return []; }
    }
    function showConfigToast(message) {
      const result = document.querySelector("#config-save-result");
      result.classList.remove("error"); result.textContent = message;
    }

    /* ── Field helpers ── */
    function setField(id, v) { document.querySelector("#" + id).value = v ?? ""; }
    function setSecretField(id, v) {
      const input = document.querySelector("#" + id);
      input.value = ""; input.placeholder = v ? "已配置，留空保持原值" : ""; input.dataset.keepSecret = v ? "1" : "";
    }
    function setChecked(id, v) { document.querySelector("#" + id).checked = Boolean(v); }
    function value(id) { return document.querySelector("#" + id).value.trim(); }
    function secretValue(id) {
      const input = document.querySelector("#" + id);
      const cur = input.value.trim();
      return cur || (input.dataset.keepSecret === "1" ? keepSecretValue : "");
    }
    function checked(id) { return document.querySelector("#" + id).checked; }
    function nullable(v) { return v || null; }
    function numberValue(id, fallback) { const p = Number(value(id)); return Number.isFinite(p) && p > 0 ? p : fallback; }
    function parseJsonField(id, fallback) {
      const raw = value(id); if (!raw) return fallback;
      const p = JSON.parse(raw); return Array.isArray(p) ? p : fallback;
    }
    function prepareSecretsForForm(input) {
      if (Array.isArray(input)) return input.map(prepareSecretsForForm);
      if (!input || typeof input !== "object") return input;
      return Object.fromEntries(Object.entries(input).map(([k, v]) => [
        k, /secret|token|apiKey|accessKey|clientSecret/i.test(k) && v ? keepSecretValue : prepareSecretsForForm(v)
      ]));
    }

    /* ── Formatting helpers ── */
    function cleanMessageText(text) { return String(text || "").replace(/<qqmedia>.*?<\\/qqmedia>/g, "").trim(); }
    function referenceToArtifact(ref) {
      const lower = String(ref || "").toLowerCase();
      const image = /\\.(png|jpe?g|webp|gif|heic)$/.test(lower);
      const audio = /\\.(wav|mp3|m4a|amr|ogg)$/.test(lower);
      const video = /\\.(mp4|mov|webm)$/.test(lower);
      return { kind: image ? "image" : audio ? "audio" : video ? "video" : "file",
        sourceUrl: /^https?:\\/\\//.test(ref) ? ref : "", localPath: /^https?:\\/\\//.test(ref) ? "" : ref,
        mimeType: image ? "image/*" : audio ? "audio/*" : video ? "video/*" : "file", fileSize: 0, originalName: basename(ref) };
    }
    function mediaPreviewUrl(item) { return item.localPath ? "/admin/api/media?path=" + encodeURIComponent(item.localPath) : item.sourceUrl || ""; }
    function basename(v) { const t = String(v || "").split(/[?#]/)[0]; return t.split(/[\\\\/]/).filter(Boolean).pop() || ""; }
    function mediaLabel(item) {
      const n = item.originalName || basename(item.localPath || item.sourceUrl);
      if (item.kind === "image") return "IMAGE\\n" + n;
      if (item.kind === "audio") return "AUDIO\\n" + n;
      if (item.kind === "video") return "VIDEO\\n" + n;
      return "FILE\\n" + n;
    }
    function fileSize(bytes) {
      const v = Number(bytes || 0);
      if (!v) return "未知大小";
      if (v < 1024) return v + " B";
      if (v < 1048576) return (v / 1024).toFixed(1) + " KB";
      return (v / 1048576).toFixed(1) + " MB";
    }
    function summaryRows(rows) {
      return rows.map(([label, v]) => '<div class="summary-row"><dt>' + escapeHtml(label) + '</dt><dd>' + cellHtml(v || muted("未设置")) + '</dd></div>').join("");
    }
    function pill(v, tone) {
      const cls = tone === "error" ? " error" : tone === "warn" ? " warn" : tone === "info" ? " info" : tone === "neutral" ? " neutral" : "";
      return html('<span class="pill' + cls + '"><span class="dot"></span>' + escapeHtml(String(v || "")) + '</span>');
    }
    function mono(v) { return html('<span style="font-family:var(--mono);font-size:11px;">' + escapeHtml(v || "") + '</span>'); }
    function muted(v) { return html('<span style="color:var(--muted);">' + escapeHtml(v || "") + '</span>'); }
    function clip(v, limit) { const t = String(v || ""); return t.length > limit ? t.slice(0, limit - 1) + "…" : t; }
    function html(v) { return { html: String(v) }; }
    function cellHtml(v) { return v && typeof v === "object" && "html" in v ? v.html : escapeHtml(v || ""); }
    function escapeHtml(v) {
      return String(v).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
    }
    function number(v) { return new Intl.NumberFormat("zh-CN").format(Number(v || 0)); }
    function dateTime(v) { return v ? new Intl.DateTimeFormat("zh-CN",{dateStyle:"medium",timeStyle:"medium"}).format(new Date(v)) : "无"; }
    function compactDate(v) { return v ? new Intl.DateTimeFormat("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}).format(new Date(v)) : "无"; }
    function time(v) { return v ? new Intl.DateTimeFormat("zh-CN",{hour:"2-digit",minute:"2-digit",second:"2-digit"}).format(new Date(v)) : "无"; }
    function duration(ms) {
      const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
      const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
      if (h > 0) return h + " 小时 " + m + " 分钟";
      if (m > 0) return m + " 分钟 " + s + " 秒";
      return s + " 秒";
    }
    function setLoading(isLoading) {
      document.querySelector("#refresh").disabled = isLoading;
      document.querySelector("#refresh").textContent = isLoading ? "刷新中" : "刷新";
    }
    function renderLoadError(error) {
      const message = error instanceof Error ? error.message : String(error);
      document.querySelector("#page-description").textContent = message;
      document.querySelector("#metric-admin-url").textContent = "读取失败";
    }

    const initial = location.hash.replace("#/", "") || "status";
    if (pageMeta[initial]) activateView(initial);
    loadAll();
  </script>
</body>
</html>`;
