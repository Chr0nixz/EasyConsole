import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { useI18n } from "../lib/i18n";
import { DEFAULT_SHELL_NAV_WIDTH, readStoredShellNavWidth } from "../lib/shell-nav-width";
import { useAuth } from "../lib/use-auth";

function storedNavWidth() {
  try {
    return readStoredShellNavWidth();
  } catch {
    return DEFAULT_SHELL_NAV_WIDTH;
  }
}

/**
 * The shell's own shape while the session restores: sidebar and header planes stand where
 * the real ones will land, so cold start reads as the app loading, not as a blank window.
 */
function RestoringShell({ label }: { label: string }) {
  return (
    <div className="flex h-dvh bg-app-bg" role="status" aria-live="polite" aria-busy="true" aria-label={label}>
      <div aria-hidden="true" className="hidden shrink-0 flex-col bg-app-sidebar px-3 md:flex" style={{ width: storedNavWidth() }}>
        <div className="flex h-14 items-center gap-2.5 px-1">
          <img src="/favicon.svg" alt="" className="h-8 w-8 shrink-0" draggable={false} />
          <div className="h-3.5 w-24 animate-pulse rounded bg-app-neutralSoft" />
        </div>
        <div className="mt-4 space-y-1.5">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="h-9 animate-pulse rounded-md bg-app-neutralSoft/60" />
          ))}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div aria-hidden="true" className="flex h-14 shrink-0 items-center px-6">
          <div className="h-4 w-28 animate-pulse rounded bg-app-neutralSoft" />
        </div>
        <p className="px-6 pt-6 text-sm text-app-muted">{label}</p>
      </div>
    </div>
  );
}

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const { t } = useI18n();
  const location = useLocation();

  if (!auth.ready || auth.restoringSession) return <RestoringShell label={t("login.restoreSession")} />;
  if (!auth.token) return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
}
