import { AlertCircle, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

export function LoadingState({ label = "正在加载" }: { label?: string }) {
  return (
    <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-app-muted">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
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
  const message = error instanceof Error ? error.message : "请求失败";
  return (
    <div className="flex min-h-32 flex-col items-center justify-center gap-3 text-center text-sm text-app-danger">
      <AlertCircle className="h-5 w-5" />
      <span>{message}</span>
      {action}
    </div>
  );
}
