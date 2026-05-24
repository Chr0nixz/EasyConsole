import { createContext, useContext } from "react";

import { i18nText } from "./i18n";
import type { RunLogInput } from "./run-logs";

export type RunLoggerContextValue = {
  log(input: Omit<RunLogInput, "channel"> & { channel?: RunLogInput["channel"] }): Promise<void>;
};

export const RunLoggerContext = createContext<RunLoggerContextValue | null>(null);

export function useRunLogger() {
  const context = useContext(RunLoggerContext);
  if (!context) throw new Error("useRunLogger must be used within RunLoggerProvider");
  return context;
}

export function errorMessage(error: unknown, fallback?: string) {
  return error instanceof Error ? error.message : (fallback ?? i18nText("操作失败", "Operation failed"));
}
