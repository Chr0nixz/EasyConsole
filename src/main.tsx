import "./styles.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { isTauri } from "@tauri-apps/api/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";

import { App } from "./App";
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

// Resolve the native runtime kind (web/desktop/mobile) before mounting so the
// renderer can pick capability flags without race conditions. On web this
// resolves immediately.
initRuntimeKind().finally(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
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
    </StrictMode>,
  );
});
