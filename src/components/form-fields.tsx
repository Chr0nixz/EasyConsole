import { useCallback, useState, type ReactNode } from "react";

import { cn } from "../lib/utils";

export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1 text-xs text-app-danger" role="alert">{message}</p>;
}

export function FormSection({ title, divided, children }: { title: string; divided?: boolean; children: ReactNode }) {
  return (
    <fieldset className={cn("space-y-3", divided && "border-t border-app-border pt-4")}>
      <legend className="mb-1 text-xs font-medium text-app-muted">{title}</legend>
      <div className="space-y-3">{children}</div>
    </fieldset>
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
