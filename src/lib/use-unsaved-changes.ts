import { useEffect } from "react";
import { useBlocker } from "react-router-dom";

/**
 * Warn before discarding dirty form state:
 * - `beforeunload` for tab/window close or refresh
 * - React Router `useBlocker` for in-app navigations (requires a data router)
 */
export function useUnsavedChanges(when: boolean, message?: string) {
  const confirmMessage =
    message ??
    "You have unsaved changes. Leave this page?";

  useEffect(() => {
    if (!when) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = confirmMessage;
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [confirmMessage, when]);

  const blocker = useBlocker(when);

  useEffect(() => {
    if (blocker.state !== "blocked") return;
    const leave = window.confirm(confirmMessage);
    if (leave) blocker.proceed();
    else blocker.reset();
  }, [blocker, confirmMessage]);

  return blocker;
}

/** Imperative confirm for dialogs that cannot rely on route blockers alone. */
export function confirmDiscardUnsavedChanges(message?: string) {
  return window.confirm(
    message ?? "You have unsaved changes. Discard them and close?",
  );
}
