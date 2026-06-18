import { useCallback, type ReactNode } from "react";

import { appendRunLog } from "../lib/run-logs";
import { browserRuntime } from "../lib/runtime";
import { RunLoggerContext, type RunLoggerContextValue } from "../lib/use-run-logger";

export function RunLoggerProvider({ children }: { children: ReactNode }) {
  const log = useCallback<RunLoggerContextValue["log"]>(async (input) => {
    try {
      await appendRunLog(browserRuntime.storage, {
        ...input,
        channel: input.channel ?? browserRuntime.runLogChannel,
      });
    } catch (error) {
      console.warn("Failed to write EasyConsole run log.", error);
    }
  }, []);

  return <RunLoggerContext.Provider value={{ log }}>{children}</RunLoggerContext.Provider>;
}
