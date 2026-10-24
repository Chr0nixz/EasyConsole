import type { Blocker } from "react-router-dom";

import { ConfirmDialog } from "./ConfirmDialog";
import { useI18n } from "../lib/i18n";

/** In-app confirm for a navigation that `useUnsavedChanges` blocked (replaces `window.confirm`). */
export function UnsavedChangesPrompt({ blocker, message }: { blocker: Blocker; message: string }) {
  const { text } = useI18n();
  const blocked = blocker.state === "blocked";
  return (
    <ConfirmDialog
      options={blocked
        ? {
            title: text("放弃未保存的更改？", "Discard unsaved changes?"),
            description: message,
            confirmLabel: text("放弃并离开", "Discard and leave"),
            tone: "danger",
            run: () => blocker.proceed?.(),
          }
        : null}
      pending={false}
      onCancel={() => blocker.reset?.()}
      onConfirm={() => blocker.proceed?.()}
    />
  );
}
