import { createContext, useContext } from "react";

/** `warning` is for something about to go wrong that the user can still stop; it keeps the neutral surface. */
export type ToastKind = "success" | "error" | "info" | "warning";

export type ToastAction = {
  label: string;
  onClick: () => void;
};

export type ToastItem = {
  id: string;
  kind: ToastKind;
  title: string;
  description?: string;
  action?: ToastAction;
  /** A quieter second choice beside `action`, such as "other durations" next to a one-step fix. */
  secondaryAction?: ToastAction;
};

export type ToastInput = Omit<ToastItem, "id"> & {
  durationMs?: number;
};

export type ToastContextValue = {
  notify(input: ToastInput): void;
  success(title: string, description?: string, action?: ToastAction): void;
  error(title: string, description?: string, action?: ToastAction): void;
  info(title: string, description?: string, action?: ToastAction): void;
};

export const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used within ToastProvider");
  return context;
}

