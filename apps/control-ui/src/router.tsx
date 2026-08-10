import { createBrowserRouter } from "react-router";
import { AppShell } from "./app-shell.js";
import { OverviewPage, RouteErrorPage, SectionPlaceholder } from "./pages.js";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: AppShell,
    ErrorBoundary: RouteErrorPage,
    children: [
      { index: true, Component: OverviewPage },
      { path: "channels", element: <SectionPlaceholder title="渠道" description="管理微信、飞书和 QQ 渠道账户。" /> },
      { path: "spaces", element: <SectionPlaceholder title="会话空间" description="查看消息与 Codex 线程绑定。" /> },
      { path: "threads", element: <SectionPlaceholder title="线程" description="管理 Codex 线程与运行中的 Turn。" /> },
      { path: "router", element: <SectionPlaceholder title="Router" description="配置自然语言控制与连接测试。" /> },
      { path: "settings", element: <SectionPlaceholder title="设置" description="规划并应用本地配置。" /> },
      { path: "diagnostics", element: <SectionPlaceholder title="诊断" description="查看运行事件并导出诊断包。" /> }
    ]
  }
]);
