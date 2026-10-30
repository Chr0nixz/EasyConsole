import { ChevronDown, Download, RefreshCw, SearchCheck, Square } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import type { BatchRunResult } from "../../lib/batch-runner";
import { useI18n } from "../../lib/i18n";
import { moveMenuFocus } from "../../lib/menu-keys";
import { claimOverlayKey, useOverlay } from "../../lib/overlay-stack";
import type { BatchExportFormat } from "./batch-export";
import type { BatchPreviewItem } from "./BatchPreviewDialog";
import { Button, Dialog, StatePill, TableRegion, type StateTone } from "../ui";

/** The per-batch item handed through preview → run → result dialogs. */
export type PreviewItem = BatchPreviewItem;

type OutcomeStatus = BatchRunResult<PreviewItem>["outcomes"][number]["status"];

export type BatchResultDialogProps = {
  open: boolean;
  title: string;
  result: BatchRunResult<PreviewItem>;
  pending?: boolean;
  onRetryFailed?: () => void;
  /**
   * Verify `unknown` items (network-failed creates that may have landed) against
   * the live task list. Only create-type batches wire this; release/delete
   * batches have no duplicate-billing risk and leave unknown items as-is.
   */
  onResolveUnknown?: () => void;
  /** True while the verification lookup is running; disables its button. */
  resolving?: boolean;
  /** Stop after the item in flight; the rest settle as skipped. Shown only while pending. */
  onStop?: () => void;
  onExport?: (format: BatchExportFormat) => void;
  onClose: () => void;
};

const EXPORT_FORMATS: Array<{ format: BatchExportFormat; label: string }> = [
  { format: "json", label: "JSON" },
  { format: "csv", label: "CSV" },
  { format: "md", label: "Markdown" },
];

function outcomeTone(status: OutcomeStatus): StateTone {
  if (status === "succeeded") return "success";
  if (status === "failed") return "danger";
  if (status === "skipped") return "warning";
  if (status === "unknown") return "warning";
  if (status === "running") return "info";
  return "neutral";
}

/**
 * Post-submit result dialog for batch operations (review 6.3): per-item outcome
 * pills, a summary line, stop while running, retry for the failed subset, and an
 * export menu. Retry only appears once the run has finished and something failed.
 */
export function BatchResultDialog({
  open,
  title,
  result,
  pending,
  onRetryFailed,
  onResolveUnknown,
  resolving,
  onStop,
  onExport,
  onClose,
}: BatchResultDialogProps) {
  const { text } = useI18n();
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const exportTriggerRef = useRef<HTMLButtonElement | null>(null);
  const exportMenuId = useId();
  const menuOpen = open && exportMenuOpen;
  const menuLayerRef = useOverlay(menuOpen, "popover");

  useEffect(() => {
    if (!menuOpen) return undefined;
    function onClickOutside(event: MouseEvent) {
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target as Node)) {
        setExportMenuOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || !claimOverlayKey(menuLayerRef.current, event)) return;
      event.stopPropagation();
      setExportMenuOpen(false);
      exportTriggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", onClickOutside);
    document.addEventListener("keydown", onKeyDown);
    window.setTimeout(() => exportMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(), 0);
    return () => {
      document.removeEventListener("pointerdown", onClickOutside);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuLayerRef, menuOpen]);

  const { outcomes, summary } = result;
  const failedCount = summary.failed;
  const unknownCount = summary.unknown;
  const retryAvailable = !pending && failedCount > 0 && Boolean(onRetryFailed);
  const resolveAvailable = !pending && unknownCount > 0 && Boolean(onResolveUnknown);
  const showErrorColumn = failedCount > 0 || unknownCount > 0;
  const stopping = Boolean(pending && stopRequested);

  return (
    <Dialog open={open} title={title} onClose={onClose} width="max-w-2xl" closeOnOverlayClick={false}>
      <div className="space-y-3 px-4 py-4">
        <p className="text-sm text-app-muted" data-testid="batch-result-summary" role="status">
          {pending
            ? text(`进行中 ${outcomes.length}/${summary.total}`, `In progress ${outcomes.length}/${summary.total}`)
            : text(`共 ${summary.total} 项`, `${summary.total} item${summary.total === 1 ? "" : "s"}`)}
          <span aria-hidden="true"> · </span>
          <span className="app-numeric">
            {text(
              `成功 ${summary.succeeded} · 失败 ${summary.failed} · 跳过 ${summary.skipped}${summary.unknown > 0 ? ` · 未知 ${summary.unknown}` : ""}`,
              `${summary.succeeded} succeeded · ${summary.failed} failed · ${summary.skipped} skipped${summary.unknown > 0 ? ` · ${summary.unknown} unknown` : ""}`,
            )}
          </span>
          {stopping ? <span>{text(" · 正在停止，当前项完成后结束", " · Stopping after the current item")}</span> : null}
        </p>

        {unknownCount > 0 && onResolveUnknown ? (
          <p className="rounded-md bg-app-panel px-3 py-2 text-xs text-app-muted">
            {text(
              "网络错误的结果未知：实例可能已经创建。请先核对，确认未创建的项才能重试，避免重复创建计费实例。",
              "Network-failed items have unknown results: the instance may already exist. Verify first — only items confirmed as not created can be retried, to avoid double-creating billed instances.",
            )}
          </p>
        ) : null}

        {outcomes.length === 0 ? (
          <p className="px-1 py-6 text-center text-sm text-app-muted">{text("还没有已完成的条目。", "No items have finished yet.")}</p>
        ) : (
          <TableRegion label={text("逐项结果", "Per-item results")} className="max-h-72 rounded-md border border-app-border">
            <table className="w-max min-w-full table-auto border-collapse text-sm">
              <thead className="bg-app-panel text-left text-xs text-app-muted">
                <tr>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium" scope="col">{text("名称", "Name")}</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium" scope="col">{text("结果", "Outcome")}</th>
                  {showErrorColumn ? (
                    <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium" scope="col">{text("错误", "Error")}</th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {outcomes.map((outcome, index) => (
                  <tr key={outcome.item.key || index} className="border-b border-app-border last:border-0">
                    <td className="max-w-80 px-3 py-2 align-middle font-medium text-app-text">
                      <span className="block break-all">{outcome.item.name}</span>
                      {outcome.item.meta ? <span className="mt-0.5 block text-xs font-normal text-app-muted">{outcome.item.meta}</span> : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle">
                      <StatePill tone={outcomeTone(outcome.status)}>{statusText(outcome.status, text)}</StatePill>
                    </td>
                    {showErrorColumn ? (
                      <td className="max-w-72 px-3 py-2 align-middle text-xs text-app-muted">
                        {outcome.error ? <span className="line-clamp-2" title={outcome.error}>{outcome.error}</span> : null}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableRegion>
        )}

        <div className="flex flex-wrap justify-end gap-2 border-t border-app-border pt-4">
          {pending && onStop ? (
            <Button
              type="button"
              variant="secondary"
              disabled={stopping}
              onClick={() => {
                setStopRequested(true);
                onStop();
              }}
            >
              <Square className="h-3.5 w-3.5" aria-hidden="true" />
              {text("停止剩余项", "Stop remaining")}
            </Button>
          ) : null}
          {onExport ? (
            <div className="relative" ref={exportMenuRef}>
              <Button
                ref={exportTriggerRef}
                aria-controls={menuOpen ? exportMenuId : undefined}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                type="button"
                variant="secondary"
                onClick={() => setExportMenuOpen((value) => !value)}
                disabled={pending}
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                {text("导出", "Export")}
                <ChevronDown className="h-3 w-3" aria-hidden="true" />
              </Button>
              {menuOpen ? (
                <div
                  id={exportMenuId}
                  aria-label={text("导出格式", "Export format")}
                  className="app-pop-enter absolute bottom-full right-0 z-30 mb-1 w-40 origin-bottom-right rounded-lg border border-app-border bg-app-elevated py-1 shadow-popover"
                  role="menu"
                  onKeyDown={handleMenuKeyDown}
                >
                  {EXPORT_FORMATS.map((entry) => (
                    <button
                      key={entry.format}
                      className="block w-full px-3 py-1.5 text-left text-sm text-app-text hover:bg-app-panel focus-visible:-outline-offset-2"
                      role="menuitem"
                      tabIndex={-1}
                      type="button"
                      onClick={() => chooseExport(entry.format)}
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {resolveAvailable ? (
            <Button type="button" variant="secondary" disabled={resolving} onClick={onResolveUnknown}>
              <SearchCheck className="h-4 w-4" aria-hidden="true" />
              {resolving
                ? text("核对中…", "Verifying…")
                : text(`核对未知项 (${unknownCount})`, `Verify unknown (${unknownCount})`)}
            </Button>
          ) : null}
          {retryAvailable ? (
            <Button type="button" variant="secondary" onClick={onRetryFailed}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              {text(`重试失败项 (${failedCount})`, `Retry failed (${failedCount})`)}
            </Button>
          ) : null}
          {/* While the run is in flight this dismisses the dialog and leaves the batch running. */}
          <Button type="button" variant="ghost" onClick={onClose}>
            {pending ? text("后台运行", "Run in background") : text("关闭", "Close")}
          </Button>
        </div>
      </div>
    </Dialog>
  );

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      setExportMenuOpen(false);
      return;
    }
    moveMenuFocus(event);
  }

  function chooseExport(format: BatchExportFormat) {
    setExportMenuOpen(false);
    exportTriggerRef.current?.focus();
    onExport?.(format);
  }
}

function statusText(status: OutcomeStatus, text: (zh: string, en: string) => string) {
  if (status === "succeeded") return text("成功", "Succeeded");
  if (status === "failed") return text("失败", "Failed");
  if (status === "skipped") return text("已跳过", "Skipped");
  if (status === "unknown") return text("结果未知", "Unknown");
  if (status === "running") return text("进行中", "Running");
  return text("等待中", "Pending");
}
