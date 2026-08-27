import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";

import { cn } from "../lib/utils";

export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1 text-xs text-app-danger" role="alert">{message}</p>;
}

export function FormSection({
  title,
  divided,
  children,
  collapsible = false,
  open = true,
  onOpenChange,
  hint,
}: {
  title: string;
  divided?: boolean;
  children: ReactNode;
  collapsible?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Optional muted summary shown beside the title when collapsed. */
  hint?: ReactNode;
}) {
  const expanded = !collapsible || open;

  if (!collapsible) {
    return (
      <fieldset className={cn("space-y-3", divided && "border-t border-app-border pt-4")}>
        <legend className="mb-1 text-xs font-medium text-app-muted">{title}</legend>
        <div className="space-y-3">{children}</div>
      </fieldset>
    );
  }

  return (
    <section className={cn("space-y-3", divided && "border-t border-app-border pt-4")}>
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-1.5 text-left text-xs font-medium text-app-muted hover:text-app-text"
        aria-expanded={expanded}
        onClick={() => onOpenChange?.(!open)}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
        <span>{title}</span>
        {!expanded && hint ? <span className="min-w-0 truncate font-normal text-app-muted">{hint}</span> : null}
      </button>
      {expanded ? <div className="space-y-3">{children}</div> : null}
    </section>
  );
}

export function fieldBorderClass(hasError: boolean) {
  return hasError ? "border-app-danger" : "";
}

export function useFormFieldErrors() {
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set());

  const markTouched = useCallback((field: string) => {
    setTouchedFields((prev) => {
      if (prev.has(field)) return prev;
      const next = new Set(prev);
      next.add(field);
      return next;
    });
  }, []);

  const touchAll = useCallback((fields: string[]) => {
    setTouchedFields(new Set(fields));
  }, []);

  const resetTouched = useCallback(() => {
    setTouchedFields(new Set());
  }, []);

  return { touchedFields, markTouched, touchAll, resetTouched };
}
