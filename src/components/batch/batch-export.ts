import type { BatchOperationRecord } from "../../lib/change-list";
import { sanitizeRunLogValue } from "../../lib/run-logs";

export type BatchExportFormat = "json" | "csv" | "md";

/**
 * Export formatters for batch operation records (review 6.3), mirroring the
 * `formatRunLogExport` / `formatRunLogCsv` / `formatRunLogMarkdown` pattern of
 * `src/lib/run-logs.ts`. Every error string goes through the run-logs
 * sanitizer so oversized or sensitive error text never leaves the app raw.
 */
export function sanitizeBatchExportError(error: string) {
  const sanitized = sanitizeRunLogValue(error);
  return typeof sanitized === "string" ? sanitized : String(sanitized);
}

export type BatchOperationExportItem = {
  id: string;
  action: BatchOperationRecord["action"];
  trigger: BatchOperationRecord["trigger"];
  accountKey: string;
  accountDisplayName: string;
  startedAt: string;
  finishedAt?: string;
  summary: BatchOperationRecord["summary"];
  retryOf?: string;
  items: Array<Pick<BatchOperationRecord["items"][number], "key" | "name" | "status" | "remoteTaskId"> & { error?: string }>;
};

/** Full-fidelity view model: per-item detail with sanitized errors. */
export function toBatchOperationExportItem(record: BatchOperationRecord): BatchOperationExportItem {
  return {
    id: record.id,
    action: record.action,
    trigger: record.trigger,
    accountKey: record.accountKey,
    accountDisplayName: record.accountDisplayName,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    summary: record.summary,
    retryOf: record.retryOf,
    items: record.items.map((item) => ({
      key: item.key,
      name: item.name,
      status: item.status,
      remoteTaskId: item.remoteTaskId,
      error: item.error ? sanitizeBatchExportError(item.error) : undefined,
    })),
  };
}

export function formatBatchOperationExport(records: BatchOperationRecord[]) {
  return JSON.stringify({ exportedAt: new Date().toISOString(), items: records.map(toBatchOperationExportItem) }, null, 2);
}

/** One line per failed item: `name (error)`; errors are sanitized first. */
function failedItemDetails(record: BatchOperationRecord) {
  return record.items
    .filter((item) => item.status === "failed")
    .map((item) => (item.error ? `${item.name} (${sanitizeBatchExportError(item.error)})` : item.name))
    .join("; ");
}

function csvEscape(value: unknown) {
  if (value === undefined || value === null) return "";
  const str = String(value);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export function formatBatchOperationCsv(records: BatchOperationRecord[]) {
  const header = ["id", "startedAt", "finishedAt", "action", "trigger", "account", "total", "succeeded", "failed", "skipped", "unknown", "retryOf", "failedItems"];
  const rows = records.map((record) =>
    [
      record.id,
      record.startedAt,
      record.finishedAt ?? "",
      record.action,
      record.trigger,
      record.accountDisplayName || record.accountKey,
      record.summary.total,
      record.summary.succeeded,
      record.summary.failed,
      record.summary.skipped,
      record.summary.unknown,
      record.retryOf ?? "",
      failedItemDetails(record),
    ]
      .map(csvEscape)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

function markdownEscape(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function formatBatchOperationMarkdown(records: BatchOperationRecord[]) {
  const header = "| Id | Started | Action | Trigger | Account | Summary | Failed items | Retry of |";
  const separator = "| --- | --- | --- | --- | --- | --- | --- | --- |";
  const rows = records.map((record) => {
    const summary = `${record.summary.succeeded}/${record.summary.total} ok, ${record.summary.failed} failed, ${record.summary.skipped} skipped${record.summary.unknown > 0 ? `, ${record.summary.unknown} unknown` : ""}`;
    const failed = failedItemDetails(record);
    return `| ${markdownEscape(record.id)} | ${markdownEscape(record.startedAt)} | ${record.action} | ${record.trigger} | ${markdownEscape(record.accountDisplayName || record.accountKey)} | ${markdownEscape(summary)} | ${markdownEscape(failed)} | ${record.retryOf ? markdownEscape(record.retryOf) : ""} |`;
  });
  return [header, separator, ...rows].join("\n");
}

/** Build the payload for one export format; callers hand it to `saveBlob`. */
export function batchExportPayload(records: BatchOperationRecord[], format: BatchExportFormat) {
  if (format === "json") return { content: formatBatchOperationExport(records), filename: `easy-console-batch-${fileStamp()}.json`, type: "application/json;charset=utf-8" };
  if (format === "csv") return { content: formatBatchOperationCsv(records), filename: `easy-console-batch-${fileStamp()}.csv`, type: "text/csv;charset=utf-8" };
  return { content: formatBatchOperationMarkdown(records), filename: `easy-console-batch-${fileStamp()}.md`, type: "text/markdown;charset=utf-8" };
}

function fileStamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}
