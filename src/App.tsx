import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "./components/AppShell";
import { AppUpdateDialog } from "./components/AppUpdateDialog";
import { LoadingState } from "./components/DataState";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { TrayMenu } from "./components/TrayMenu";
import { ToastProvider } from "./components/Toast";
import { AppUpdateProvider } from "./lib/app-update-context";
import { DownloadQueueProvider } from "./lib/download-queue-context";

const DashboardPage = lazy(() => import("./pages/DashboardPage").then((module) => ({ default: module.DashboardPage })));
const ImagesPage = lazy(() => import("./pages/ImagesPage").then((module) => ({ default: module.ImagesPage })));
const LoginPage = lazy(() => import("./pages/LoginPage").then((module) => ({ default: module.LoginPage })));
const RunLogsPage = lazy(() => import("./pages/RunLogsPage").then((module) => ({ default: module.RunLogsPage })));
const ScheduledTasksPage = lazy(() => import("./pages/ScheduledTasksPage").then((module) => ({ default: module.ScheduledTasksPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const StoragePage = lazy(() => import("./pages/StoragePage").then((module) => ({ default: module.StoragePage })));
const TaskTemplatesPage = lazy(() => import("./pages/TaskTemplatesPage").then((module) => ({ default: module.TaskTemplatesPage })));
const TasksPage = lazy(() => import("./pages/TasksPage").then((module) => ({ default: module.TasksPage })));

export function App() {
  return (
    <ToastProvider>
      <DownloadQueueProvider>
        <AppUpdateProvider>
          <Suspense fallback={<LoadingState />}>
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
        </AppUpdateProvider>
      </DownloadQueueProvider>
    </ToastProvider>
  );
}
