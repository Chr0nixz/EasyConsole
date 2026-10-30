import { X } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type ComponentType,
  type InputHTMLAttributes,
  type MouseEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";

import { exitPresets, useExitGhost } from "../lib/exit-motion";
import { useI18n } from "../lib/i18n";
import { claimOverlayKey, useOverlay } from "../lib/overlay-stack";
import { useCompactLayout } from "../lib/use-compact-layout";
import { useMobileBackLayer } from "../lib/use-mobile-back-stack";
import { useSlidingIndicator } from "../lib/use-sliding-indicator";
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

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  /**
   * Why a disabled button is disabled. With a reason the button stays focusable
   * (`aria-disabled` instead of `disabled`) and the reason is its description and tooltip:
   * a natively disabled button is skipped by Tab, so a `title` alone is never heard.
   */
  disabledReason?: string;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  className,
  variant = "primary",
  disabled,
  disabledReason,
  title,
  onClick,
  "aria-describedby": describedBy,
  ...props
}, ref) {
  const reasonId = useId();
  const explained = Boolean(disabled && disabledReason);
  const button = (
    <button
      ref={ref}
      aria-describedby={explained ? [describedBy, reasonId].filter(Boolean).join(" ") : describedBy}
      aria-disabled={explained || undefined}
      className={cn(
        "app-interactive inline-flex h-9 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:shadow-none [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11",
        variant === "primary" && "bg-app-accent text-app-onAccent shadow-raised hover:brightness-[0.94] active:brightness-90",
        variant === "secondary" && "border border-app-borderStrong bg-app-surface text-app-text shadow-raised hover:border-app-muted hover:bg-app-panel",
        variant === "ghost" && "text-app-muted hover:bg-app-panel hover:text-app-text",
        variant === "danger" && "bg-app-danger text-app-onAccent shadow-raised hover:brightness-[0.94] active:brightness-90",
        className,
      )}
      disabled={explained ? undefined : disabled}
      title={explained ? disabledReason : title}
      onClick={explained ? (event) => event.preventDefault() : onClick}
      {...props}
    />
  );
  if (!explained) return button;
  // The reason sits beside the button, not inside it, so it never joins the accessible name.
  return (
    <>
      {button}
      <span id={reasonId} hidden>{disabledReason}</span>
    </>
  );
});

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        "h-9 rounded-md border border-app-borderStrong bg-app-surface px-3 text-sm text-app-text placeholder:text-app-muted hover:border-app-muted disabled:cursor-not-allowed disabled:bg-app-panel disabled:text-app-muted [@media(pointer:coarse)]:min-h-11",
        props.className,
      )}
    />
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn("h-9 rounded-md border border-app-borderStrong bg-app-surface px-3 text-sm text-app-text hover:border-app-muted disabled:cursor-not-allowed disabled:bg-app-panel disabled:text-app-muted [@media(pointer:coarse)]:min-h-11", props.className)}
    />
  );
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cn(
        "min-h-24 rounded-md border border-app-borderStrong bg-app-surface px-3 py-2 text-sm leading-6 text-app-text placeholder:text-app-muted hover:border-app-muted disabled:cursor-not-allowed disabled:bg-app-panel disabled:text-app-muted [@media(pointer:coarse)]:min-h-32",
        props.className,
      )}
    />
  );
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn("rounded-lg border border-app-border bg-app-surface shadow-shell", className)}>{children}</section>;
}

export type StateTone = "info" | "success" | "warning" | "danger" | "neutral";

const STATE_PILL_TONES: Record<StateTone, string> = {
  info: "bg-app-infoSoft text-app-info ring-app-infoRing",
  success: "bg-app-successSoft text-app-success ring-app-successRing",
  warning: "bg-app-warningSoft text-app-warningText ring-app-warningRing",
  danger: "bg-app-dangerSoft text-app-danger ring-app-dangerRing",
  neutral: "bg-app-neutralSoft text-app-muted ring-app-neutralRing",
};

/**
 * The status pill: full round, soft fill, inset ring, a still dot and text. Every
 * state readout (task status, batch item outcome, ledger result) uses this shape,
 * so a state never reads like a setting.
 */
export function StatePill({ tone, children, className }: { tone: StateTone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full py-0.5 pl-2 pr-2.5 text-xs font-medium leading-5 ring-1 ring-inset",
        STATE_PILL_TONES[tone],
        className,
      )}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      {children}
    </span>
  );
}

/** The squared neutral tag for settings and metadata (release condition, retry-of, IDs): no hue, an optional muted icon. */
export function SettingTag({ icon: Icon, children, className, title }: { icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>; children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-[5px] bg-app-neutralSoft px-2 py-0.5 text-xs font-medium leading-5 text-app-text", className)}
      title={title}
    >
      {Icon ? <Icon className="h-3 w-3 shrink-0 text-app-muted" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/** Determinate progress: a neutral track and an accent fill that slides in by transform, never by width. */
export function ProgressBar({ value, label, className }: { value: number; label: string; className?: string }) {
  const percent = Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
  return (
    <div
      className={cn("h-1.5 overflow-hidden rounded-full bg-app-neutralSoft", className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
    >
      <div
        className="h-full w-full rounded-full bg-app-accent transition-transform duration-[var(--app-motion-emphasized)] ease-[var(--app-ease-out)] motion-reduce:transition-none"
        style={{ transform: `translateX(${percent - 100}%)` }}
      />
    </div>
  );
}

export type SegmentedOption<T extends string> = {
  value: T;
  label: ReactNode;
  title?: string;
  ariaLabel?: string;
};

/** Mutually exclusive options with one raised thumb that glides to the selection. */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
  optionClassName,
}: {
  value: T;
  options: Array<SegmentedOption<T>>;
  onChange: (value: T, event: MouseEvent<HTMLButtonElement>) => void;
  label: string;
  className?: string;
  optionClassName?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const indicatorRef = useRef<HTMLSpanElement | null>(null);
  useSlidingIndicator(containerRef, indicatorRef, '[aria-pressed="true"]', value);

  return (
    <div ref={containerRef} className={cn("relative inline-flex shrink-0 items-center gap-0.5 rounded-md bg-app-panel p-0.5", className)} role="group" aria-label={label}>
      <span ref={indicatorRef} aria-hidden="true" className="app-sliding-indicator rounded-[6px] bg-app-thumb shadow-raised" />
      {options.map((option) => (
        <button
          key={option.value}
          aria-label={option.ariaLabel}
          aria-pressed={option.value === value}
          className={cn(
            "app-interactive relative inline-flex h-7 items-center justify-center gap-1.5 rounded-[6px] px-2.5 text-xs font-medium text-app-muted hover:text-app-text aria-pressed:text-app-text [@media(pointer:coarse)]:min-h-10",
            optionClassName,
          )}
          title={option.title}
          type="button"
          onClick={(event) => onChange(option.value, event)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
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
  contained = false,
  describedBy,
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
  /** Let the child own scrolling, with room for a persistent form footer. */
  contained?: boolean;
  /** Id of the element that states what the dialog is about to do, read out with the title on open. */
  describedBy?: string;
}) {
  const titleId = useId();
  const { t } = useI18n();
  const compactLayout = useCompactLayout();
  const viewport = useVisualViewport(open && compactLayout);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  useExitGhost(open, overlayRef, exitPresets.dialog);
  // Only the topmost overlay answers Escape and traps Tab (a picker or confirm can sit on top).
  const layerRef = useOverlay(open, "modal");
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
        // Mid-composition (pinyin candidates open) Escape belongs to the IME, not the dialog.
        if (event.isComposing || !claimOverlayKey(layerRef.current, event)) return;
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab" || !claimOverlayKey(layerRef.current, event)) return;

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
  }, [open, layerRef]);

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
      ref={overlayRef}
      className={cn(
        "app-modal-overlay fixed inset-0 z-50 flex items-start justify-center px-3 py-4 sm:px-4 sm:py-10",
        mobileMode === "bottom-sheet" && "items-end px-0 py-0 sm:items-start sm:px-4 sm:py-10",
        mobileMode === "fullscreen" && "items-stretch px-0 py-0 sm:items-start sm:px-4 sm:py-10",
      )}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      onMouseDown={handleOverlayClick}
      style={compactLayout ? { top: viewport.offsetTop, bottom: "auto", height: viewport.height } : undefined}
    >
      <div
        ref={dialogRef}
        data-exit-panel=""
        tabIndex={-1}
        className={cn(
          "app-modal-panel max-h-[calc(100vh-2rem)] w-full overflow-hidden rounded-lg bg-app-elevated sm:max-h-[calc(100vh-5rem)]",
          mobileMode === "bottom-sheet" && "max-h-[90dvh] rounded-b-none rounded-t-lg sm:max-h-[calc(100vh-5rem)] sm:rounded-lg",
          mobileMode === "fullscreen" && "flex h-[100dvh] max-h-[100dvh] flex-col rounded-none sm:block sm:h-auto sm:max-h-[calc(100vh-5rem)] sm:rounded-lg",
          contained && "flex flex-col sm:flex sm:h-[calc(100dvh-5rem)]",
          contained && mobileMode !== "fullscreen" && "h-[calc(100dvh-2rem)]",
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
        <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-app-border pl-5 pr-3">
          <h2 id={titleId} className="truncate text-[0.9375rem] font-semibold tracking-[-0.01em] text-app-text">{title}</h2>
          <button
            className="app-interactive flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-app-muted hover:bg-app-panel hover:text-app-text [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
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
            contained
              ? "flex min-h-0 flex-1 flex-col overflow-hidden"
              : "max-h-[calc(100vh-5rem)] overflow-auto sm:max-h-[calc(100vh-8rem)]",
            !contained && mobileMode === "fullscreen" && "min-h-0 flex flex-1 flex-col !h-auto max-h-none sm:block sm:flex-none sm:!h-auto sm:max-h-[calc(100vh-8rem)]",
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
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  useExitGhost(open, overlayRef, exitPresets.drawer);
  // Only the topmost overlay answers Escape and traps Tab (a picker or confirm can sit on top).
  const layerRef = useOverlay(open, "modal");
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
        // Mid-composition (pinyin candidates open) Escape belongs to the IME, not the dialog.
        if (event.isComposing || !claimOverlayKey(layerRef.current, event)) return;
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab" || !claimOverlayKey(layerRef.current, event)) return;

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
  }, [open, layerRef]);

  useMobileBackLayer(open, onClose);

  if (!open) return null;

  const handleOverlayClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!closeOnOverlayClick || event.target !== event.currentTarget) return;
    onClose();
  };

  return createPortal(
    <div
      ref={overlayRef}
      className={cn("app-drawer-overlay fixed inset-0 z-50 flex justify-end", mobileMode === "bottom-sheet" && "items-end")}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={handleOverlayClick}
      style={compactLayout ? { top: viewport.offsetTop, bottom: "auto", height: viewport.height } : undefined}
    >
      <div
        ref={drawerRef}
        data-exit-panel={mobileMode === "bottom-sheet" ? "sheet" : "side"}
        tabIndex={-1}
        className={cn(
          "app-drawer-panel flex h-full w-full flex-col overflow-hidden border-l border-app-border bg-app-elevated",
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
        <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-app-border pl-5 pr-3">
          <h2 id={titleId} className="truncate text-[0.9375rem] font-semibold tracking-[-0.01em] text-app-text">{title}</h2>
          <button
            className="app-interactive flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-app-muted hover:bg-app-panel hover:text-app-text [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
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
