import { AlertCircle, FolderOpen, Inbox, Loader2, SearchX } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { isAuthError, isNetworkError } from "../lib/api-client";
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
            <div className="h-8 w-8 animate-pulse rounded-full bg-app-panel" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-1/3 animate-pulse rounded bg-app-panel" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-app-panel" />
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
                "h-4 animate-pulse rounded bg-app-panel",
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
    <div className="flex min-h-32 flex-col items-center justify-center gap-3 text-center text-sm text-app-muted">
      <Icon className="h-8 w-8 opacity-50" aria-hidden="true" />
      <div className="space-y-1">
        <span className="block font-medium text-app-text">{title}</span>
        {description ? <span className="block text-xs text-app-muted">{description}</span> : null}
      </div>
      {action}
    </div>
  );
}

export { Inbox as InboxIcon, SearchX as SearchXIcon, FolderOpen as FolderOpenIcon };

export function ErrorState({ error, action }: { error: unknown; action?: ReactNode }) {
  const { t } = useI18n();
  const authError = isAuthError(error);
  const networkError = isNetworkError(error);
  const message = authError
    ? t("common.loginExpired")
    : networkError
      ? t("common.networkError")
      : error instanceof Error
        ? error.message
        : t("common.requestFailed");
  return (
    <div className="flex min-h-32 flex-col items-center justify-center gap-3 text-center text-sm text-app-danger" role="alert" aria-live="assertive" aria-atomic="true">
      <AlertCircle className="h-5 w-5" aria-hidden="true" />
      <span>{message}</span>
      {action}
    </div>
  );
}
