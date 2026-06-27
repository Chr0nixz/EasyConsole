import "./styles.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { isTauri } from "@tauri-apps/api/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";

import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { RunLoggerProvider } from "./components/RunLoggerProvider";
import { AuthProvider } from "./lib/auth-context";
import { I18nProvider } from "./lib/i18n";
import { initRuntimeKind } from "./lib/runtime";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const Router = isTauri() ? HashRouter : BrowserRouter;

// Surface unhandled promise rejections and synchronous errors so they show up
// in the console alongside the ErrorBoundary logs. These do not block rendering.
window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled promise rejection.", event.reason);
});
window.addEventListener("error", (event) => {
  console.error("Uncaught error.", event.error ?? event.message);
});

// Resolve the native runtime kind (web/desktop/mobile) before mounting so the
// renderer can pick capability flags without race conditions. On web this
// resolves immediately.
initRuntimeKind().finally(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <AuthProvider>
              <RunLoggerProvider>
                <Router>
                  <App />
                </Router>
              </RunLoggerProvider>
            </AuthProvider>
          </I18nProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
});
