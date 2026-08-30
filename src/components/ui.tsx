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
import { useCompactLayout } from "../lib/use-compact-layout";
import { useMobileBackLayer } from "../lib/use-mobile-back-stack";
import { useVisualViewport } from "../lib/use-visual-viewport";
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

function isDialogCloseControl(element: HTMLElement) {
  return element.hasAttribute("data-dialog-close");
}

function isAutofocused(element: HTMLElement) {
  return element.hasAttribute("autofocus") || element.getAttribute("data-autofocus") != null;
}

function isFormControl(element: HTMLElement) {
  const tag = element.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return true;
  const role = element.getAttribute("role");
  return role === "combobox" || role === "textbox" || role === "searchbox";
}

function getInitialDialogFocus(container: HTMLElement | null): HTMLElement | null {
  if (!container) return null;
  const focusable = getFocusableElements(container);
  if (focusable.length === 0) return container;

  const content = focusable.filter((element) => !isDialogCloseControl(element));
  const pool = content.length > 0 ? content : focusable;
  return pool.find(isAutofocused) ?? pool.find(isFormControl) ?? pool[0] ?? container;
}

function focusDialogContents(container: HTMLElement | null) {
  if (!container) return;
  const active = document.activeElement;
  if (
    active instanceof HTMLElement
    && container.contains(active)
    && active !== container
    && !isDialogCloseControl(active)
  ) {
    return;
  }
  getInitialDialogFocus(container)?.focus();
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

export const TableRegion = forwardRef<HTMLDivElement, { children: ReactNode; label: string; className?: string; "aria-activedescendant"?: string }>(
  function TableRegion({ children, label, className, "aria-activedescendant": activeDescendant }, ref) {
    return (
      <div
        ref={ref}
        className={cn("app-table-region overflow-auto", className)}
        role="region"
        aria-label={label}
        aria-activedescendant={activeDescendant}
        tabIndex={0}
      >
        {children}
      </div>
    );
  },
);

let dialogScrollLockCount = 0;

export function Dialog({
  open,
  title,
  children,
  onClose,
  width = "max-w-3xl",
  closeOnOverlayClick = true,
  onOverlayClick,
  mobileMode = "default",
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  width?: string;
  closeOnOverlayClick?: boolean;
  /** When set, overlay clicks call this instead of `onClose` (e.g. confirm discard). */
  onOverlayClick?: () => void;
  mobileMode?: "default" | "bottom-sheet" | "fullscreen";
}) {
  const titleId = useId();
  const { t } = useI18n();
  const compactLayout = useCompactLayout();
  const viewport = useVisualViewport(open && compactLayout);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  // Keep latest onClose without re-running focus/lock setup (unstable callbacks stole input focus).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    dialogScrollLockCount += 1;
    if (dialogScrollLockCount === 1) {
      document.body.style.overflow = "hidden";
    }

    window.setTimeout(() => focusDialogContents(dialogRef.current), 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
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
      dialogScrollLockCount = Math.max(0, dialogScrollLockCount - 1);
      if (dialogScrollLockCount === 0) {
        document.body.style.overflow = "";
      }
      previousFocusRef.current?.focus();
    };
  }, [open]);

  useMobileBackLayer(open, onClose);

  if (!open) return null;

  const handleOverlayClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (onOverlayClick) {
      onOverlayClick();
      return;
    }
    if (!closeOnOverlayClick) return;
    onClose();
  };

  return createPortal(
    <div
      className={cn(
        "app-modal-overlay fixed inset-0 z-50 flex items-start justify-center px-3 py-4 sm:px-4 sm:py-10",
        mobileMode === "bottom-sheet" && "items-end px-0 py-0 sm:items-start sm:px-4 sm:py-10",
      )}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={handleOverlayClick}
      style={compactLayout ? { top: viewport.offsetTop, bottom: "auto", height: viewport.height } : undefined}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={cn(
          "app-modal-panel max-h-[calc(100vh-2rem)] w-full overflow-hidden rounded-lg bg-app-surface sm:max-h-[calc(100vh-5rem)]",
          mobileMode === "bottom-sheet" && "max-h-[90dvh] rounded-b-none rounded-t-lg sm:max-h-[calc(100vh-5rem)] sm:rounded-lg",
          mobileMode === "fullscreen" && "flex h-[100dvh] max-h-[100dvh] flex-col rounded-none sm:block sm:h-auto sm:max-h-[calc(100vh-5rem)] sm:rounded-lg",
          width,
        )}
        style={
          compactLayout && mobileMode === "fullscreen"
            ? { height: viewport.height, maxHeight: viewport.height }
            : compactLayout && mobileMode === "bottom-sheet"
              ? { maxHeight: Math.floor(viewport.height * 0.9) }
              : undefined
        }
      >
        <div className="flex h-12 items-center justify-between border-b border-app-border px-4">
          <h2 id={titleId} className="text-sm font-semibold text-app-text">{title}</h2>
          <button
            className="flex h-8 w-8 items-center justify-center rounded-md text-app-muted hover:bg-app-panel hover:text-app-text [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
            data-dialog-close=""
            type="button"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
            <span className="sr-only">{t("common.close")}</span>
          </button>
        </div>
        <div
          className={cn(
            "max-h-[calc(100vh-5rem)] overflow-auto sm:max-h-[calc(100vh-8rem)]",
            mobileMode === "fullscreen" && "min-h-0 flex flex-1 flex-col !h-auto max-h-none sm:block sm:flex-none sm:!h-auto sm:max-h-[calc(100vh-8rem)]",
          )}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({
  open,
  title,
  children,
  onClose,
  width = "max-w-xl",
  closeOnOverlayClick = true,
  mobileMode = "bottom-sheet",
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  width?: string;
  closeOnOverlayClick?: boolean;
  mobileMode?: "bottom-sheet" | "fullscreen" | "default";
}) {
  const titleId = useId();
  const { t } = useI18n();
  const compactLayout = useCompactLayout();
  const viewport = useVisualViewport(open && compactLayout);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    dialogScrollLockCount += 1;
    if (dialogScrollLockCount === 1) {
      document.body.style.overflow = "hidden";
    }

    window.setTimeout(() => focusDialogContents(drawerRef.current), 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = getFocusableElements(drawerRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        drawerRef.current?.focus();
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
      dialogScrollLockCount = Math.max(0, dialogScrollLockCount - 1);
      if (dialogScrollLockCount === 0) {
        document.body.style.overflow = "";
      }
      previousFocusRef.current?.focus();
    };
  }, [open]);

  useMobileBackLayer(open, onClose);

  if (!open) return null;

  const handleOverlayClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!closeOnOverlayClick || event.target !== event.currentTarget) return;
    onClose();
  };

  return createPortal(
    <div
      className={cn("app-drawer-overlay fixed inset-0 z-50 flex justify-end", mobileMode === "bottom-sheet" && "items-end")}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={handleOverlayClick}
      style={compactLayout ? { top: viewport.offsetTop, bottom: "auto", height: viewport.height } : undefined}
    >
      <div
        ref={drawerRef}
        tabIndex={-1}
        className={cn(
          "app-drawer-panel flex h-full w-full flex-col overflow-hidden border-l border-app-border bg-app-surface shadow-shell",
          mobileMode === "bottom-sheet" && "h-auto max-h-[90dvh] rounded-t-lg border-l-0 border-t sm:h-full sm:max-h-none sm:rounded-none sm:border-l sm:border-t-0",
          mobileMode === "fullscreen" && "h-[100dvh] rounded-none border-0",
          width,
        )}
        style={
          compactLayout && mobileMode === "fullscreen"
            ? { height: viewport.height }
            : compactLayout && mobileMode === "bottom-sheet"
              ? { maxHeight: Math.floor(viewport.height * 0.9) }
              : undefined
        }
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-app-border px-4">
          <h2 id={titleId} className="truncate text-sm font-semibold text-app-text">{title}</h2>
          <button
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-app-muted hover:bg-app-panel hover:text-app-text [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
            data-dialog-close=""
            type="button"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
            <span className="sr-only">{t("common.close")}</span>
          </button>
        </div>
        <div className={cn("min-h-0 flex-1 overflow-auto", mobileMode === "fullscreen" && "pb-[env(safe-area-inset-bottom)]")}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}
