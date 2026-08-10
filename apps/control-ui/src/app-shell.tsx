import { NavLink, Outlet } from "react-router";
import { Icon, type IconName } from "./icons.js";

export const navigation = [
  { path: "/", label: "概览", icon: "overview" },
  { path: "/channels", label: "渠道", icon: "channels" },
  { path: "/spaces", label: "会话空间", icon: "spaces" },
  { path: "/threads", label: "线程", icon: "threads" },
  { path: "/router", label: "Router", icon: "router" },
  { path: "/settings", label: "设置", icon: "settings" },
  { path: "/diagnostics", label: "诊断", icon: "diagnostics" }
] as const satisfies ReadonlyArray<{
  path: string;
  label: string;
  icon: IconName;
}>;

export function AppShell() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="window-controls" aria-hidden="true">
          <span className="window-dot window-dot-red" />
          <span className="window-dot window-dot-amber" />
          <span className="window-dot window-dot-green" />
        </div>
        <div className="brand">QQ Codex Bridge</div>
        <nav className="primary-nav" aria-label="主导航">
          {navigation.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === "/"}
              className={({ isActive }) => `nav-item${isActive ? " nav-item-active" : ""}`}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span>vNext 0.2.0</span>
          <span className="info-mark" aria-label="版本信息">i</span>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="local-runtime"><span className="status-dot status-ready" />本机运行</div>
        </header>
        <main className="main-content" id="main-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
