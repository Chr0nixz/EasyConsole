import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { ToastContext, type ToastInput, type ToastItem, type ToastKind, type ToastContextValue } from "../lib/use-toast";
import { cn } from "../lib/utils";

function createToastId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function iconFor(kind: ToastKind) {
  if (kind === "success") return <CheckCircle2 className="h-4 w-4 text-app-success" />;
  if (kind === "error") return <AlertCircle className="h-4 w-4 text-app-danger" />;
  return <Info className="h-4 w-4 text-app-accent" />;
}

function getToastClasses(kind: ToastKind) {
  if (kind === "success") return "border-app-success/40 bg-emerald-50";
  if (kind === "error") return "border-app-danger/40 bg-red-50";
  return "border-app-accent/35 bg-sky-50";
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const remove = useCallback((id: string) => {
    setToasts((items) => items.filter((item) => item.id !== id));
  }, []);

  const notify = useCallback(
    ({ durationMs = 3500, ...input }: ToastInput) => {
      const id = createToastId();
      setToasts((items) => [...items, { id, ...input }].slice(-4));
      window.setTimeout(() => remove(id), durationMs);
    },
    [remove],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      notify,
      success: (title, description) => notify({ kind: "success", title, description }),
      error: (title, description) => notify({ kind: "error", title, description }),
      info: (title, description) => notify({ kind: "info", title, description }),
    }),
    [notify],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              "rounded-md border p-3 shadow-popover",
              getToastClasses(toast.kind),
            )}
          >
            <div className="flex items-start gap-2">
              <div className="mt-0.5">{iconFor(toast.kind)}</div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-app-text">{toast.title}</div>
                {toast.description ? <div className="mt-1 text-xs leading-5 text-app-muted">{toast.description}</div> : null}
              </div>
              <button
                className="rounded p-1 text-app-muted hover:bg-app-panel hover:text-app-text"
                type="button"
                onClick={() => remove(toast.id)}
              >
                <X className="h-3.5 w-3.5" />
                <span className="sr-only">关闭提示</span>
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
