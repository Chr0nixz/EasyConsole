import { X } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type MouseEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../lib/i18n";
import { cn } from "../lib/utils";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function getFocusableElements(container: HTMLElement | null) {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true",
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }>(function Button({
  className,
  variant = "primary",
  ...props
}, ref) {
  return (
    <button
      ref={ref}
      className={cn(
        "app-interactive inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11",
        variant === "primary" && "bg-app-accent text-app-onAccent hover:brightness-95 active:brightness-90",
        variant === "secondary" && "border border-app-border bg-app-surface text-app-text hover:bg-app-panel",
        variant === "ghost" && "text-app-muted hover:bg-app-panel hover:text-app-text",
        variant === "danger" && "bg-app-danger text-app-onAccent hover:brightness-95",
        className,
      )}
      {...props}
    />
  );
});

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        "h-9 rounded-md border border-app-border bg-app-surface px-3 text-sm text-app-text placeholder:text-app-muted [@media(pointer:coarse)]:min-h-11",
        props.className,
      )}
    />
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn("h-9 rounded-md border border-app-border bg-app-surface px-3 text-sm text-app-text [@media(pointer:coarse)]:min-h-11", props.className)}
    />
  );
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cn(
        "min-h-24 rounded-md border border-app-border bg-app-surface px-3 py-2 text-sm text-app-text placeholder:text-app-muted [@media(pointer:coarse)]:min-h-32",
        props.className,
      )}
    />
  );
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn("app-surface-enter rounded-lg border border-app-border bg-app-surface shadow-shell", className)}>{children}</section>;
}

export function TableRegion({ children, label, className }: { children: ReactNode; label: string; className?: string }) {
  return (
    <div className={cn("app-table-region overflow-auto", className)} role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

export function Dialog({
  open,
  title,
  children,
  onClose,
  width = "max-w-3xl",
  closeOnOverlayClick = true,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  width?: string;
  closeOnOverlayClick?: boolean;
}) {
  const titleId = useId();
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    window.setTimeout(() => getFocusableElements(dialogRef.current)[0]?.focus(), 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = getFocusableElements(dialogRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;

      if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus();
        return;
      }

      if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [onClose, open]);

  if (!open) return null;

  const handleOverlayClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!closeOnOverlayClick || event.target !== event.currentTarget) return;
    onClose();
  };

  return createPortal(
    <div
      className="app-modal-overlay fixed inset-0 z-50 flex items-start justify-center px-3 py-4 sm:px-4 sm:py-10"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={handleOverlayClick}
    >
      <div
        ref={dialogRef}
        className={cn("app-modal-panel max-h-[calc(100vh-2rem)] w-full overflow-hidden rounded-lg bg-app-surface sm:max-h-[calc(100vh-5rem)]", width)}
      >
        <div className="flex h-12 items-center justify-between border-b border-app-border px-4">
          <h2 id={titleId} className="text-sm font-semibold text-app-text">{title}</h2>
          <button className="flex h-8 w-8 items-center justify-center rounded-md text-app-muted hover:bg-app-panel hover:text-app-text [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11" type="button" onClick={onClose}>
            <X className="h-4 w-4" />
            <span className="sr-only">{t("common.close")}</span>
          </button>
        </div>
        <div className="max-h-[calc(100vh-5rem)] overflow-auto sm:max-h-[calc(100vh-8rem)]">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
