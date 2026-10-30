import { AlertTriangle, ChevronDown, ChevronRight, ClipboardList, History, RefreshCw, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { EmptyState, ErrorState, LoadingState } from "../DataState";
import { Button, Panel, Select, SettingTag, StatePill, type StateTone } from "../ui";
import type { BatchOperationAction, BatchOperationRecord } from "../../lib/change-list";
import { listBatchOperations } from "../../lib/change-list";
import { useI18n } from "../../lib/i18n";
import type { Locale } from "../../lib/i18n-text";
import { browserRuntime } from "../../lib/runtime";

type ActionFilter = BatchOperationAction | "all";
type ResultFilter = "all" | "succeeded" | "with-failures";

const actionText: Record<BatchOperationAction, { zh: string; en: string }> = {
  release: { zh: "批量释放", en: "Batch release" },
  delete: { zh: "批量删除", en: "Batch delete" },
  create: { zh: "批量创建", en: "Batch create" },
  "template-apply": { zh: "模板执行", en: "Template apply" },
};

const triggerText: Record<BatchOperationRecord["trigger"], { zh: string; en: string }> = {
  ui: { zh: "界面", en: "UI" },
  cli: { zh: "CLI", en: "CLI" },
};

const itemStatusText: Record<BatchOperationRecord["items"][number]["status"], { zh: string; en: string }> = {
  pending: { zh: "等待中", en: "Pending" },
  running: { zh: "进行中", en: "Running" },
  succeeded: { zh: "成功", en: "Succeeded" },
  failed: { zh: "失败", en: "Failed" },
  skipped: { zh: "已跳过", en: "Skipped" },
  unknown: { zh: "结果未知", en: "Unknown" },
};

function itemStatusTone(status: BatchOperationRecord["items"][number]["status"]): StateTone {
  if (status === "succeeded") return "success";
  if (status === "failed") return "danger";
  if (status === "skipped") return "warning";
  if (status === "unknown") return "warning";
  if (status === "running") return "info";
  return "neutral";
}

function localized(entry: { zh: string; en: string }, locale: Locale) {
  return locale === "en-US" ? entry.en : entry.zh;
}

function formatRecordTime(value: string, locale: Locale) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale, { hour12: false });
}

function recordHasFailures(record: BatchOperationRecord) {
  return record.summary.failed > 0;
}

/** Records that are neither failed nor unknown are the only clean ones. */
function recordHasUnknown(record: BatchOperationRecord) {
  return record.summary.unknown > 0;
}

/**
 * Collapsible "recent batch operations" panel (review 6.3). Read-only history
 * over the local change list: filter by action/result, expand a record to see
 * per-item outcomes and failure reasons. A host page that can re-run an action
 * (the task list for release/delete) passes `onRetryFailed`; nothing is replayed
 * automatically, and the retry goes through the host's normal confirm step.
 */
export function BatchHistoryPanel({
  refreshSignal,
  onRetryFailed,
  retryableActions = [],
}: {
  refreshSignal?: string;
  /** Re-run the failed items of a record through the host page's confirm step. */
  onRetryFailed?: (record: BatchOperationRecord) => void;
  /** Actions the host page can re-run; other records only show their history. */
  retryableActions?: BatchOperationAction[];
} = {}) {
  const { locale, text } = useI18n();
  const [records, setRecords] = useState<BatchOperationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [actionFilter, setActionFilter] = useState<ActionFilter>("all");
  const [resultFilter, setResultFilter] = useState<ResultFilter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const reload = useCallback(
    () =>
      listBatchOperations(browserRuntime.storage)
        .then((list) => {
          setRecords(list);
          setLoadError(null);
        })
        .catch((error) => setLoadError(error instanceof Error ? error : new Error(text("批量操作记录读取失败", "Failed to read batch operations"))))
        .finally(() => setLoading(false)),
    [text],
  );

  useEffect(() => {
    void reload();
    // Batches can be appended from this page or from the CLI/MCP wrappers, so
    // re-read on focus instead of holding the mount-time snapshot.
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  useEffect(() => {
    if (refreshSignal) void reload();
  }, [reload, refreshSignal]);

  // Point at the run being retried by when it ran, not by its internal id.
  const retryOfLabel = (id: string) => {
    const original = records.find((record) => record.id === id);
    return original
      ? text(`重试自 ${formatRecordTime(original.startedAt, locale)} 的操作`, `Retry of the run at ${formatRecordTime(original.startedAt, locale)}`)
      : text("重试自已清理的记录", "Retry of a pruned record");
  };

  const filtered = records.filter((record) => {
    if (actionFilter !== "all" && record.action !== actionFilter) return false;
    if (resultFilter === "succeeded" && recordHasFailures(record)) return false;
    if (resultFilter === "with-failures" && !recordHasFailures(record)) return false;
    return true;
  });

  // Until the first batch finishes there is nothing to look back on; the panel appears with
  // the first record (the host's refreshSignal re-reads it) instead of sitting empty under the list.
  if (!loading && !loadError && records.length === 0) return null;

  return (
    <Panel className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-app-border px-3 py-2">
        <button
          type="button"
          className="app-interactive flex items-center gap-2 rounded text-sm font-semibold text-app-text"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? <ChevronRight className="h-4 w-4 text-app-muted" aria-hidden="true" /> : <ChevronDown className="h-4 w-4 text-app-muted" aria-hidden="true" />}
          <History className="h-4 w-4 text-app-muted" aria-hidden="true" />
          {text("最近批量操作", "Recent batch operations")}
        </button>
        {!collapsed ? (
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label={text("按动作筛选", "Filter by action")}
              className="h-8 text-xs"
              value={actionFilter}
              onChange={(event) => setActionFilter(event.target.value as ActionFilter)}
            >
              <option value="all">{text("全部动作", "All actions")}</option>
              <option value="release">{text("批量释放", "Batch release")}</option>
              <option value="delete">{text("批量删除", "Batch delete")}</option>
              <option value="create">{text("批量创建", "Batch create")}</option>
              <option value="template-apply">{text("模板执行", "Template apply")}</option>
            </Select>
            <Select
              aria-label={text("按结果筛选", "Filter by result")}
              className="h-8 text-xs"
              value={resultFilter}
              onChange={(event) => setResultFilter(event.target.value as ResultFilter)}
            >
              <option value="all">{text("全部结果", "All results")}</option>
              <option value="succeeded">{text("全部成功", "All succeeded")}</option>
              <option value="with-failures">{text("有失败", "With failures")}</option>
            </Select>
            <Button className="h-8 px-2" type="button" variant="ghost" onClick={() => void reload()}>
              <RefreshCw className="h-4 w-4" />
              {text("刷新", "Refresh")}
            </Button>
          </div>
        ) : null}
      </div>

      {!collapsed ? (
        loadError ? (
          <ErrorState
            error={loadError}
            action={
              <Button variant="secondary" onClick={() => void reload()}>
                {text("重新加载", "Reload")}
              </Button>
            }
          />
        ) : loading ? (
          <LoadingState />
        ) : records.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title={text("暂无批量操作记录", "No batch operations yet")}
            description={text(
              "批量释放、删除、创建和模板执行在完成后都会在这里留档，失败项可在原操作入口重试。",
              "Batch release, delete, create, and template runs are recorded here once finished; failed items are retried from the original entry point.",
            )}
          />
        ) : (
          <ul className="divide-y divide-app-border" aria-label={text("批量操作记录", "Batch operation records")}>
            {filtered.length === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-app-muted">{text("没有匹配当前筛选的批量操作。", "No batch operations match the current filter.")}</li>
            ) : null}
            {filtered.map((record) => {
              const expanded = expandedId === record.id;
              return (
                <li key={record.id} className="px-3 py-2.5 text-sm">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <button
                      type="button"
                      className="app-interactive flex h-6 w-6 items-center justify-center rounded text-app-muted hover:bg-app-panel hover:text-app-text"
                      aria-expanded={expanded}
                      aria-label={text(`展开 ${localized(actionText[record.action], locale)} 记录`, `Expand ${localized(actionText[record.action], locale)} record`)}
                      onClick={() => setExpandedId(expanded ? null : record.id)}
                    >
                      {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </button>
                    <time className="app-numeric text-app-muted" dateTime={record.startedAt}>
                      {formatRecordTime(record.startedAt, locale)}
                    </time>
                    <StatePill tone={recordHasFailures(record) ? "danger" : recordHasUnknown(record) ? "warning" : "success"}>
                      {recordHasFailures(record)
                        ? text(`失败 ${record.summary.failed}/${record.summary.total}`, `Failed ${record.summary.failed}/${record.summary.total}`)
                        : recordHasUnknown(record)
                          ? text(`未知 ${record.summary.unknown}/${record.summary.total}`, `Unknown ${record.summary.unknown}/${record.summary.total}`)
                          : text(`成功 ${record.summary.succeeded}/${record.summary.total}`, `Succeeded ${record.summary.succeeded}/${record.summary.total}`)}
                    </StatePill>
                    <span className="font-medium">{localized(actionText[record.action], locale)}</span>
                    <span className="text-xs text-app-muted">
                      {localized(triggerText[record.trigger], locale)} · {record.accountDisplayName || record.accountKey}
                    </span>
                    {record.retryOf ? (
                      <SettingTag icon={RotateCcw} title={record.retryOf}>
                        {retryOfLabel(record.retryOf)}
                      </SettingTag>
                    ) : null}
                  </div>
                  {expanded ? (
                    <div className="mt-2 space-y-2 pl-8">
                      <ul className="space-y-1.5">
                        {record.items.map((item) => (
                          <li key={item.key} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                            <StatePill tone={itemStatusTone(item.status)}>
                              {localized(itemStatusText[item.status], locale)}
                            </StatePill>
                            <span className="font-mono text-app-muted">{item.remoteTaskId ?? item.key}</span>
                            <span className="min-w-0 flex-1 truncate text-app-text" title={item.name}>{item.name}</span>
                            {item.error ? <span className="text-app-danger">{item.error}</span> : null}
                          </li>
                        ))}
                      </ul>
                      {recordHasFailures(record) && onRetryFailed && retryableActions.includes(record.action) ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <Button className="h-8 px-2" type="button" variant="secondary" onClick={() => onRetryFailed(record)}>
                            <RotateCcw className="h-4 w-4" aria-hidden="true" />
                            {text(`重试 ${record.summary.failed} 个失败项`, `Retry ${record.summary.failed} failed`)}
                          </Button>
                          <span className="text-xs text-app-muted">
                            {text("先确认影响清单再执行，结果会关联到本条记录。", "You confirm the impact list first; the retry links back to this record.")}
                          </span>
                        </div>
                      ) : recordHasFailures(record) ? (
                        <p className="flex items-start gap-1.5 text-xs text-app-muted">
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-app-warning" aria-hidden="true" />
                          {text(
                            "失败项不会自动重放；请在对应的批量操作入口重新发起，结果会作为重试记录关联到本条。",
                            "Failed items are never replayed automatically; re-issue them from the original batch entry point — the retry is linked back to this record.",
                          )}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </Panel>
  );
}
