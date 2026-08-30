import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type ReactNode } from "react";

import { ToastContext, type ToastInput, type ToastItem, type ToastKind, type ToastContextValue } from "../lib/use-toast";
import { useI18n } from "../lib/i18n";
import { useVisualViewport } from "../lib/use-visual-viewport";
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
  if (kind === "success") return "border-app-successRing bg-app-successSoft";
  if (kind === "error") return "border-app-dangerRing bg-app-dangerSoft";
  return "border-app-infoRing bg-app-infoSoft";
}

type ToastTimer = {
  remainingMs: number;
  startedAt: number;
  timeoutId: number | null;
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const viewport = useVisualViewport();
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef(new Map<string, ToastTimer>());

  const clearTimer = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer?.timeoutId != null) window.clearTimeout(timer.timeoutId);
    timersRef.current.delete(id);
  }, []);

  const remove = useCallback((id: string) => {
    clearTimer(id);
    setToasts((items) => items.filter((item) => item.id !== id));
  }, [clearTimer]);

  const armTimer = useCallback((id: string, remainingMs: number) => {
    const existing = timersRef.current.get(id);
    if (existing?.timeoutId != null) window.clearTimeout(existing.timeoutId);
    const timeoutId = window.setTimeout(() => remove(id), remainingMs);
    timersRef.current.set(id, { remainingMs, startedAt: Date.now(), timeoutId });
  }, [remove]);

  const pauseTimer = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (!timer || timer.timeoutId == null) return;
    window.clearTimeout(timer.timeoutId);
    const elapsed = Date.now() - timer.startedAt;
    timersRef.current.set(id, {
      remainingMs: Math.max(0, timer.remainingMs - elapsed),
      startedAt: timer.startedAt,
      timeoutId: null,
    });
  }, []);

  const resumeTimer = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (!timer || timer.timeoutId != null) return;
    armTimer(id, timer.remainingMs);
  }, [armTimer]);

  const notify = useCallback(
    ({ durationMs, ...input }: ToastInput) => {
      const id = createToastId();
      const resolvedDuration = durationMs ?? (input.kind === "error" ? 8000 : 3500);
      setToasts((items) => [...items, { id, ...input }].slice(-4));
      armTimer(id, resolvedDuration);
    },
    [armTimer],
  );

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) {
      if (timer.timeoutId != null) window.clearTimeout(timer.timeoutId);
    }
    timersRef.current.clear();
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      notify,
      success: (title, description, action) => notify({ kind: "success", title, description, action }),
      error: (title, description, action) => notify({ kind: "error", title, description, action }),
      info: (title, description, action) => notify({ kind: "info", title, description, action }),
    }),
    [notify],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="app-toast-container fixed bottom-4 right-4 z-40 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
        style={{ "--app-visual-viewport-bottom-inset": `${viewport.bottomInset}px` } as CSSProperties}
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              "app-toast-enter rounded-md border p-3 shadow-popover",
              getToastClasses(toast.kind),
            )}
            role={toast.kind === "error" ? "alert" : "status"}
            aria-live={toast.kind === "error" ? "assertive" : "polite"}
            aria-atomic="true"
            onPointerEnter={() => pauseTimer(toast.id)}
            onPointerLeave={() => resumeTimer(toast.id)}
            onFocus={() => pauseTimer(toast.id)}
            onBlur={(event: FocusEvent<HTMLDivElement>) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) resumeTimer(toast.id);
            }}
          >
            <div className="flex items-start gap-2">
              <div className="mt-0.5">{iconFor(toast.kind)}</div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-app-text">{toast.title}</div>
                {toast.description ? <div className="mt-1 text-xs leading-5 text-app-muted">{toast.description}</div> : null}
                {toast.action ? (
                  <button
                    type="button"
                    className="app-interactive mt-2 rounded border border-app-border px-2 py-0.5 text-xs font-medium text-app-text hover:bg-app-panel"
                    onClick={() => {
                      toast.action?.onClick();
                      remove(toast.id);
                    }}
                  >
                    {toast.action.label}
                  </button>
                ) : null}
              </div>
              <button
                className="app-interactive rounded p-1 text-app-muted hover:bg-app-panel hover:text-app-text"
                type="button"
                onClick={() => remove(toast.id)}
              >
                <X className="h-3.5 w-3.5" />
                <span className="sr-only">{t("common.closeToast")}</span>
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
