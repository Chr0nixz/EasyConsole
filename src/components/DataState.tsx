import { AlertCircle, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import { cn } from "../lib/utils";

export function LoadingState({ label }: { label?: string }) {
  const { t } = useI18n();

  return (
    <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-app-muted">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label ?? t("common.loading")}
    </div>
  );
}

export function TableSkeleton({ rows = 6, columns = 5, className }: { rows?: number; columns?: number; className?: string }) {
  const { t } = useI18n();

  return (
    <div className={cn("space-y-2 p-3", className)} aria-label={t("common.loadingTable")}>
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

export function EmptyState({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center gap-3 text-center text-sm text-app-muted">
      <span>{title}</span>
      {action}
    </div>
  );
}

export function ErrorState({ error, action }: { error: unknown; action?: ReactNode }) {
  const { t } = useI18n();
  const message = error instanceof Error ? error.message : t("common.requestFailed");
  return (
    <div className="flex min-h-32 flex-col items-center justify-center gap-3 text-center text-sm text-app-danger">
      <AlertCircle className="h-5 w-5" />
      <span>{message}</span>
      {action}
    </div>
  );
}
