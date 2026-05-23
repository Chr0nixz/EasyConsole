import { X } from "lucide-react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

import { cn } from "../lib/utils";

export function Button({
  className,
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  return (
    <button
      className={cn(
        "inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" && "bg-app-accent text-white hover:brightness-95 active:brightness-90",
        variant === "secondary" && "border border-app-border bg-app-surface text-app-text hover:bg-app-panel",
        variant === "ghost" && "text-app-muted hover:bg-app-panel hover:text-app-text",
        variant === "danger" && "bg-app-danger text-white hover:brightness-95",
        className,
      )}
      {...props}
    />
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        "h-9 rounded-md border border-app-border bg-app-surface px-3 text-sm text-app-text placeholder:text-app-muted",
        props.className,
      )}
    />
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn("h-9 rounded-md border border-app-border bg-app-surface px-3 text-sm text-app-text", props.className)}
    />
  );
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cn(
        "min-h-24 rounded-md border border-app-border bg-app-surface px-3 py-2 text-sm text-app-text placeholder:text-app-muted",
        props.className,
      )}
    />
  );
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn("rounded-lg border border-app-border bg-app-surface shadow-shell", className)}>{children}</section>;
}

export function Dialog({
  open,
  title,
  children,
  onClose,
  width = "max-w-3xl",
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  width?: string;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/25 px-4 py-10" role="dialog" aria-modal="true">
      <div className={cn("max-h-[calc(100vh-5rem)] w-full overflow-hidden rounded-lg bg-app-surface shadow-popover", width)}>
        <div className="flex h-12 items-center justify-between border-b border-app-border px-4">
          <h2 className="text-sm font-semibold text-app-text">{title}</h2>
          <button className="rounded-md p-1 text-app-muted hover:bg-app-panel hover:text-app-text" type="button" onClick={onClose}>
            <X className="h-4 w-4" />
            <span className="sr-only">关闭</span>
          </button>
        </div>
        <div className="max-h-[calc(100vh-8rem)] overflow-auto">{children}</div>
      </div>
    </div>
  );
}
