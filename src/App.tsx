import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "./components/AppShell";
import { LoadingState } from "./components/DataState";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { ToastProvider } from "./components/Toast";

const DashboardPage = lazy(() => import("./pages/DashboardPage").then((module) => ({ default: module.DashboardPage })));
const ImagesPage = lazy(() => import("./pages/ImagesPage").then((module) => ({ default: module.ImagesPage })));
const LoginPage = lazy(() => import("./pages/LoginPage").then((module) => ({ default: module.LoginPage })));
const StoragePage = lazy(() => import("./pages/StoragePage").then((module) => ({ default: module.StoragePage })));
const TasksPage = lazy(() => import("./pages/TasksPage").then((module) => ({ default: module.TasksPage })));

export function App() {
  return (
    <ToastProvider>
      <Suspense fallback={<LoadingState />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
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
            <Route path="storage" element={<StoragePage />} />
            <Route path="images" element={<ImagesPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </ToastProvider>
  );
}
