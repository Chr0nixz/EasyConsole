import { createContext, useContext } from "react";

export type ToastKind = "success" | "error" | "info";

export type ToastItem = {
  id: string;
  kind: ToastKind;
  title: string;
  description?: string;
};

export type ToastInput = Omit<ToastItem, "id"> & {
  durationMs?: number;
};

export type ToastContextValue = {
  notify(input: ToastInput): void;
  success(title: string, description?: string): void;
  error(title: string, description?: string): void;
  info(title: string, description?: string): void;
};

export const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used within ToastProvider");
  return context;
}

