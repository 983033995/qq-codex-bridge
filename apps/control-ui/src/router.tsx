import { createBrowserRouter } from "react-router";
import { AppShell } from "./app-shell.js";
import { ChannelsPage, OverviewPage, RouteErrorPage } from "./pages.js";
import { DiagnosticsPage, RouterPage, SettingsPage, SpacesPage, TasksPage } from "./operations-pages.js";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: AppShell,
    ErrorBoundary: RouteErrorPage,
    children: [
      { index: true, Component: OverviewPage },
      { path: "channels", Component: ChannelsPage },
      { path: "spaces", Component: SpacesPage },
      { path: "threads", Component: TasksPage },
      { path: "router", Component: RouterPage },
      { path: "settings", Component: SettingsPage },
      { path: "diagnostics", Component: DiagnosticsPage }
    ]
  }
]);
