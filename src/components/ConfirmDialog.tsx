import type { ReactNode } from "react";

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

  return (
    <Dialog
      closeOnOverlayClick={!pending}
      open={Boolean(options)}
      title={options?.title ?? t("confirm.title")}
      width="max-w-md"
      onClose={pending ? () => {} : onCancel}
    >
      <div className="space-y-4 p-4">
        <div className="text-sm leading-6 text-app-muted">{options?.description}</div>
        <div className="flex justify-end gap-2 border-t border-app-border pt-3">
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
