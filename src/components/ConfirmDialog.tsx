import { useId, type ReactNode } from "react";

import { Button, Dialog } from "./ui";
import { useI18n } from "../lib/i18n";

export type ConfirmOptions = {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  tone?: "default" | "danger";
  run: () => unknown | Promise<unknown>;
};

export function ConfirmDialog({
  options,
  pending,
  onCancel,
  onConfirm,
}: {
  options: ConfirmOptions | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  // Focus lands on Cancel, so the consequences must be read with the title, not only seen.
  const descriptionId = useId();

  return (
    <Dialog
      closeOnOverlayClick={!pending}
      describedBy={descriptionId}
      // Phones: a bottom sheet with Cancel and the action side by side, Cancel first, so a
      // destructive action is never a full-width bar stacked straight on top of Cancel.
      mobileMode="bottom-sheet"
      open={Boolean(options)}
      title={options?.title ?? t("confirm.title")}
      width="max-w-md"
      onClose={pending ? () => {} : onCancel}
    >
      <div className="space-y-4 p-4">
        <div id={descriptionId} className="text-sm leading-6 text-app-muted">{options?.description}</div>
        <div className="grid grid-cols-2 gap-3 border-t border-app-border pt-3 sm:flex sm:justify-end sm:gap-2">
          <Button disabled={pending} type="button" variant="secondary" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button disabled={pending} type="button" variant={options?.tone === "danger" ? "danger" : "primary"} onClick={onConfirm}>
            {pending ? t("common.processing") : (options?.confirmLabel ?? t("common.confirm"))}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
