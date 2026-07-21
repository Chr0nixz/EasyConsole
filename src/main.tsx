import "./styles.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";

import { createAppRouter } from "./App";
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

const router = createAppRouter();

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
                <RouterProvider router={router} />
              </RunLoggerProvider>
            </AuthProvider>
          </I18nProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
});
