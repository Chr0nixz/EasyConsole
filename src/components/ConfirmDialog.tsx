import type { ReactNode } from "react";

import { Button, Dialog } from "./ui";

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
  return (
    <Dialog
      closeOnOverlayClick={!pending}
      open={Boolean(options)}
      title={options?.title ?? "确认操作"}
      width="max-w-md"
      onClose={pending ? () => {} : onCancel}
    >
      <div className="space-y-4 p-4">
        <div className="text-sm leading-6 text-app-muted">{options?.description}</div>
        <div className="flex justify-end gap-2 border-t border-app-border pt-3">
          <Button disabled={pending} type="button" variant="secondary" onClick={onCancel}>
            取消
          </Button>
          <Button disabled={pending} type="button" variant={options?.tone === "danger" ? "danger" : "primary"} onClick={onConfirm}>
            {pending ? "处理中" : (options?.confirmLabel ?? "确认")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
