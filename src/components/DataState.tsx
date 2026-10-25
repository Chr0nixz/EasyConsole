import { AlertCircle, FolderOpen, Inbox, Loader2, SearchX } from "lucide-react";
import { useContext, type ComponentType, type ReactNode } from "react";
import { Link, useInRouterContext } from "react-router-dom";

import { isAuthError, isNetworkError } from "../lib/api-client";
import { getRuntimeSettings } from "../lib/app-settings";
import { AuthContext } from "../lib/auth-state";
import { useI18n } from "../lib/i18n";
import { cn } from "../lib/utils";

export type EmptyStateIcon = ComponentType<{ className?: string }>;

export function LoadingState({ label, variant = "spinner" }: { label?: string; variant?: "spinner" | "skeleton" }) {
  const { t } = useI18n();
  const loadingLabel = label ?? t("common.loading");

  if (variant === "skeleton") {
    return (
      <div className="space-y-3 p-4" role="status" aria-live="polite" aria-busy="true" aria-atomic="true" aria-label={loadingLabel}>
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex items-center gap-3">
            <div className="h-8 w-8 animate-pulse rounded-full bg-app-neutralSoft" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-1/3 animate-pulse rounded bg-app-neutralSoft" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-app-neutralSoft" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-app-muted" role="status" aria-live="polite" aria-busy="true" aria-atomic="true" aria-label={loadingLabel}>
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      {loadingLabel}
    </div>
  );
}

export function TableSkeleton({ rows = 6, columns = 5, className }: { rows?: number; columns?: number; className?: string }) {
  const { t } = useI18n();

  return (
    <div className={cn("space-y-2 p-3", className)} role="status" aria-live="polite" aria-busy="true" aria-atomic="true" aria-label={t("common.loadingTable")}>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div key={rowIndex} className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          {Array.from({ length: columns }, (_, columnIndex) => (
            <div
              key={columnIndex}
              className={cn(
                "h-4 animate-pulse rounded bg-app-neutralSoft",
                columnIndex === 0 ? "w-full" : "w-3/4",
                rowIndex === 0 && "opacity-80",
              )}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, description, action, icon: Icon = Inbox }: { title: string; description?: ReactNode; action?: ReactNode; icon?: EmptyStateIcon }) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-3 px-4 py-6 text-center text-sm text-app-muted">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-app-panel text-app-muted ring-1 ring-inset ring-app-border">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="max-w-sm space-y-1">
        <span className="block font-medium text-app-text">{title}</span>
        {description ? <span className="block text-xs leading-5 text-app-muted">{description}</span> : null}
      </div>
      {action}
    </div>
  );
}

export { Inbox as InboxIcon, SearchX as SearchXIcon, FolderOpen as FolderOpenIcon };

/** The API host requests go to, so a connection failure can name what it could not reach. */
function apiHost() {
  try {
    return new URL(getRuntimeSettings().apiBaseUrl).host;
  } catch {
    return "";
  }
}

export function ErrorState({ error, action }: { error: unknown; action?: ReactNode }) {
  const { t, text } = useI18n();
  // Read the context directly: ErrorState also renders outside the signed-in tree.
  const auth = useContext(AuthContext);
  const inRouter = useInRouterContext();
  const authError = isAuthError(error);
  const networkError = isNetworkError(error);
  // A lab console behind a VPN fails here while the machine itself is online, so the message
  // names the host and points at where the address is set, not only at "the network".
  const host = networkError ? apiHost() : "";
  const message = authError
    ? t("common.loginExpired")
    : networkError
      ? host
        ? text(`无法连接到 ${host}。请检查网络、VPN 或代理，以及 API 地址是否正确。`, `Cannot reach ${host}. Check the network, VPN or proxy, and whether the API address is right.`)
        : t("common.networkError")
      : error instanceof Error
        ? error.message
        : t("common.requestFailed");
  const settingsLink = networkError && inRouter ? (
    <Link
      className="app-interactive inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-app-muted hover:bg-app-panel hover:text-app-text"
      to={auth?.token ? "/settings" : "/login/settings"}
    >
      {text("检查 API 设置", "Check API settings")}
    </Link>
  ) : null;
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-3 px-4 py-6 text-center text-sm text-app-danger" role="alert" aria-live="assertive" aria-atomic="true">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-app-dangerSoft ring-1 ring-inset ring-app-dangerRing">
        <AlertCircle className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="max-w-md leading-5">{message}</span>
      {authError && auth?.token ? (
        <button
          type="button"
          className="app-interactive inline-flex h-9 items-center rounded-md bg-app-accent px-3 text-sm font-medium text-app-onAccent shadow-raised"
          onClick={() => void auth.logout({ expired: true })}
        >
          {t("common.signInAgain")}
        </button>
      ) : settingsLink ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {action}
          {settingsLink}
        </div>
      ) : action}
    </div>
  );
}
