import { useEffect } from "react";
import { useBlocker } from "react-router-dom";

import { i18nText } from "./i18n-text";

/**
 * Warn before discarding dirty form state:
 * - `beforeunload` for tab/window close or refresh (the browser shows its own prompt)
 * - React Router `useBlocker` for in-app navigations (requires a data router). The caller
 *   renders `<UnsavedChangesPrompt blocker={...} />` for the in-app confirm.
 */
export function useUnsavedChanges(when: boolean, message?: string) {
  const confirmMessage = message ?? i18nText("有未保存的更改，确定要离开吗？", "You have unsaved changes. Leave this page?");

  useEffect(() => {
    if (!when) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = confirmMessage;
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [confirmMessage, when]);

  return useBlocker(when);
}
