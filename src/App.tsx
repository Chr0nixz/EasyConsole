import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";

import { AppShell } from "./components/AppShell";
import { AppUpdateDialog } from "./components/AppUpdateDialog";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LoadingState } from "./components/DataState";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { TrayMenu } from "./components/TrayMenu";
import { ToastProvider } from "./components/Toast";
import { AppUpdateProvider } from "./lib/app-update-context";
import { CommitQueueProvider } from "./lib/commit-queue-context";
import { DownloadQueueProvider } from "./lib/download-queue-context";
import { browserRuntime } from "./lib/runtime";

// Maps an `easyconsole://` deep-link URL to an in-app route. Returns null when
// the URL does not look like a navigable deep link so callers can ignore it.
function deepLinkToPath(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    // Accept both `easyconsole://path` (host is the first segment) and
    // `easyconsole:///path` styles defensively.
    const path = url.pathname ? decodeURIComponent(url.pathname) : "";
    const host = url.hostname ? `/${url.hostname}` : "";
    const candidate = `${host}${path}`.replace(/\/+/g, "/");
    if (!candidate || candidate === "/") return null;
    // Only allow internal app routes we actually expose. Keeps arbitrary
    // navigation from external callers bounded.
    const ALLOWED_PREFIXES = [
      "/dashboard",
      "/tasks",
      "/scheduled-tasks",
      "/task-templates",
      "/storage",
      "/images",
      "/run-logs",
      "/settings",
    ];
    return ALLOWED_PREFIXES.some((prefix) => candidate === prefix || candidate.startsWith(`${prefix}/`))
      ? candidate
      : null;
  } catch {
    return null;
  }
}

// Listens for desktop deep-link events (scheme `easyconsole://`) and navigates
// to the matching in-app route. On non-desktop runtimes `onDeepLink` resolves
// to a no-op unsubscribe, so the effect is a cheap no-op there.
function DeepLinkHandler() {
  const navigate = useNavigate();
  useEffect(() => {
    let active = true;
    let detach: (() => void) | null = null;
    void browserRuntime.onDeepLink((urls) => {
      if (!active) return;
      for (const raw of urls) {
        const path = deepLinkToPath(raw);
        if (path) {
          navigate(path);
          break;
        }
      }
    }).then((fn) => {
      if (!active) {
        try {
          fn();
        } catch {
          /* ignore */
        }
        return;
      }
      detach = fn;
    });
    return () => {
      active = false;
      detach?.();
    };
  }, [navigate]);
  return null;
}

const DashboardPage = lazy(() => import("./pages/DashboardPage").then((module) => ({ default: module.DashboardPage })));
const ImagesPage = lazy(() => import("./pages/ImagesPage").then((module) => ({ default: module.ImagesPage })));
const LoginPage = lazy(() => import("./pages/LoginPage").then((module) => ({ default: module.LoginPage })));
const RunLogsPage = lazy(() => import("./pages/RunLogsPage").then((module) => ({ default: module.RunLogsPage })));
const ScheduledTasksPage = lazy(() => import("./pages/ScheduledTasksPage").then((module) => ({ default: module.ScheduledTasksPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const StoragePage = lazy(() => import("./pages/StoragePage").then((module) => ({ default: module.StoragePage })));
const TaskTemplatesPage = lazy(() => import("./pages/TaskTemplatesPage").then((module) => ({ default: module.TaskTemplatesPage })));
const TasksPage = lazy(() => import("./pages/TasksPage").then((module) => ({ default: module.TasksPage })));
const TaskDetailPage = lazy(() => import("./pages/TaskDetailPage").then((module) => ({ default: module.TaskDetailPage })));

export function App() {
  return (
    <ToastProvider>
      <DownloadQueueProvider>
        <CommitQueueProvider>
        <AppUpdateProvider>
          <ErrorBoundary showHomeInFallback={false}>
          <Suspense fallback={<LoadingState />}>
            <DeepLinkHandler />
            <Routes>
              <Route path="/tray-menu" element={<TrayMenu />} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/login/settings" element={<SettingsPage standalone />} />
              <Route
                path="/"
                element={
                  <ProtectedRoute>
                    <AppShell />
                  </ProtectedRoute>
                }
              >
                <Route index element={<Navigate to="/dashboard" replace />} />
                <Route path="dashboard" element={<DashboardPage />} />
                <Route path="tasks" element={<TasksPage />} />
                <Route path="tasks/:id" element={<TaskDetailPage />} />
                <Route path="scheduled-tasks" element={<ScheduledTasksPage />} />
                <Route path="task-templates" element={<TaskTemplatesPage />} />
                <Route path="storage" element={<StoragePage />} />
                <Route path="images" element={<ImagesPage />} />
                <Route path="run-logs" element={<RunLogsPage />} />
                <Route path="settings" element={<SettingsPage />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            <AppUpdateDialog />
          </Suspense>
          </ErrorBoundary>
        </AppUpdateProvider>
        </CommitQueueProvider>
      </DownloadQueueProvider>
    </ToastProvider>
  );
}
