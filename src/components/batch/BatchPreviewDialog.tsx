import { AlertTriangle } from "lucide-react";
import { useId, type ReactNode } from "react";

import { Button, Dialog, StatePill, TableRegion } from "../ui";
import { useI18n } from "../../lib/i18n";

export type BatchPreviewItem = {
  /** Stable per-item identity (remote task id, payload ordinal, ...); never rendered. */
  key: string;
  name: string;
  meta?: string;
  irreversible?: boolean;
};

export type BatchPreviewDialogProps = {
  open: boolean;
  title: string;
  tone: "default" | "danger";
  items: BatchPreviewItem[];
  account: { displayName: string };
  confirmLabel: string;
  /** Aggregate consequences shown above the list (totals, what is lost). */
  summary?: ReactNode;
  pending?: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

/**
 * Pre-submit impact list for batch operations (review 6.3). Lists every item
 * the batch will touch plus the account it runs under, states irreversibility in
 * text (never color alone), and gates the confirm button on a non-empty list so
 * an empty batch cannot be submitted. When every item is irreversible the note
 * says so once instead of flagging each row.
 */
export function BatchPreviewDialog({ open, title, tone, items, account, confirmLabel, summary, pending, onConfirm, onClose }: BatchPreviewDialogProps) {
  const { text } = useI18n();
  const irreversibleCount = items.filter((item) => item.irreversible).length;
  const allIrreversible = items.length > 0 && irreversibleCount === items.length;
  const flagRows = irreversibleCount > 0 && !allIrreversible;
  const confirmDisabled = pending || items.length === 0;
  // The consequences (summary, account, irreversibility) are read with the title on open;
  // the per-item list stays out of the description so it is browsed, not recited.
  const descriptionId = useId();

  return (
    <Dialog open={open} title={title} onClose={onClose} width="max-w-2xl" closeOnOverlayClick={false} describedBy={descriptionId}>
      <div className="space-y-3 px-4 py-4">
        <div id={descriptionId} className="space-y-3">
          {summary ? <div className="text-sm text-app-muted">{summary}</div> : null}

          <p className="text-sm text-app-muted">
            {text("当前账号", "Account")}
            {text("：", ": ")}
            <span className="font-medium text-app-text">{account.displayName || text("未登录", "Not signed in")}</span>
            <span aria-hidden="true"> · </span>
            {text(`共 ${items.length} 项`, `${items.length} item${items.length === 1 ? "" : "s"}`)}
          </p>

          {irreversibleCount > 0 ? (
            <div className="flex items-start gap-2 rounded-md bg-app-dangerSoft px-3 py-2 text-sm text-app-danger" role="note">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                {allIrreversible
                  ? text(
                      `以下 ${items.length} 项提交后都无法从 EasyConsole 撤销。`,
                      `EasyConsole cannot undo any of these ${items.length} item${items.length === 1 ? "" : "s"} once submitted.`,
                    )
                  : text(
                      `其中 ${irreversibleCount} 项提交后无法撤销，已在清单中标出。`,
                      `${irreversibleCount} item${irreversibleCount === 1 ? " is" : "s are"} irreversible and marked in the list.`,
                    )}
              </span>
            </div>
          ) : null}
        </div>

        {items.length === 0 ? (
          <p className="px-1 py-6 text-center text-sm text-app-muted">{text("没有待提交的条目。", "No items to submit.")}</p>
        ) : (
          <TableRegion label={text("影响清单", "Impact list")} className="max-h-72 rounded-md border border-app-border">
            <table className="w-max min-w-full table-auto border-collapse text-sm">
              <thead className="bg-app-panel text-left text-xs text-app-muted">
                <tr>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium" scope="col">{text("名称", "Name")}</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium" scope="col">{text("摘要", "Summary")}</th>
                  {flagRows ? (
                    <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium" scope="col">{text("标记", "Flag")}</th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.key} className="border-b border-app-border last:border-0">
                    <td className="max-w-80 px-3 py-2 align-middle font-medium text-app-text">
                      <span className="block break-all">{item.name}</span>
                    </td>
                    <td className="max-w-96 px-3 py-2 align-middle text-xs text-app-muted">
                      {item.meta ? <span className="app-numeric line-clamp-2" title={item.meta}>{item.meta}</span> : null}
                    </td>
                    {flagRows ? (
                      <td className="whitespace-nowrap px-3 py-2 align-middle">
                        {item.irreversible ? <StatePill tone="danger">{text("不可逆", "Irreversible")}</StatePill> : null}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableRegion>
        )}

        <div className="flex justify-end gap-2 border-t border-app-border pt-4">
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
            {text("取消", "Cancel")}
          </Button>
          <Button type="button" variant={tone === "danger" ? "danger" : "primary"} onClick={onConfirm} disabled={confirmDisabled}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
