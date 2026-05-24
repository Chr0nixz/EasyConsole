import { createContext, useContext } from "react";

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

export function errorMessage(error: unknown, fallback = "操作失败") {
  return error instanceof Error ? error.message : fallback;
}
