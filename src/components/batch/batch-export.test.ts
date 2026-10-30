import { describe, expect, it } from "vitest";

import type { BatchOperationRecord } from "../../lib/change-list";
import {
  formatBatchOperationCsv,
  formatBatchOperationExport,
  formatBatchOperationMarkdown,
  sanitizeBatchExportError,
  toBatchOperationExportItem,
} from "./batch-export";

function makeRecord(overrides: Partial<BatchOperationRecord> = {}): BatchOperationRecord {
  return {
    id: "batch-1",
    action: "delete",
    trigger: "ui",
    accountKey: "alice@116.172.93.164:28080",
    accountDisplayName: "Alice",
    startedAt: "2026-10-24T08:00:00.000Z",
    finishedAt: "2026-10-24T08:00:05.000Z",
    items: [
      { key: "101", name: "alpha-01", status: "succeeded", remoteTaskId: "101" },
      { key: "102", name: "alpha-02", status: "failed", error: "network reset" },
      { key: "103", name: "alpha-03", status: "skipped" },
    ],
    summary: { total: 3, succeeded: 1, failed: 1, skipped: 1, unknown: 0 },
    ...overrides,
  };
}

describe("batch-export", () => {
  it("formats records as JSON with an export timestamp and full per-item detail", () => {
    const parsed = JSON.parse(formatBatchOperationExport([makeRecord()])) as {
      exportedAt: string;
      items: Array<{ id: string; action: string; summary: { total: number }; items: Array<{ name: string; error?: string; remoteTaskId?: string }> }>;
    };

    expect(parsed.exportedAt).toBeTruthy();
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].id).toBe("batch-1");
    expect(parsed.items[0].action).toBe("delete");
    expect(parsed.items[0].summary.total).toBe(3);
    expect(parsed.items[0].items.find((item) => item.name === "alpha-01")?.remoteTaskId).toBe("101");
    expect(parsed.items[0].items.find((item) => item.name === "alpha-02")?.error).toBe("network reset");
  });

  it("sanitizes error text: oversize errors truncate, non-string input degrades to a string", () => {
    const longError = "x".repeat(1500);
    const sanitized = sanitizeBatchExportError(longError);
    expect(sanitized.length).toBe(1003);
    expect(sanitized.endsWith("...")).toBe(true);

    // toBatchOperationExportItem routes every item error through the sanitizer.
    const exported = toBatchOperationExportItem(makeRecord({ items: [{ key: "9", name: "big", status: "failed", error: longError }], summary: { total: 1, succeeded: 0, failed: 1, skipped: 0, unknown: 0 } }));
    expect(exported.items[0].error?.length).toBe(1003);
  });

  it("formats CSV with a header row and escaped failed-item details", () => {
    const csv = formatBatchOperationCsv([
      makeRecord({ items: [{ key: "5", name: "odd, name", status: "failed", error: 'quote " inside' }], summary: { total: 1, succeeded: 0, failed: 1, skipped: 0, unknown: 0 } }),
    ]);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("id,startedAt,finishedAt,action,trigger,account,total,succeeded,failed,skipped,unknown,retryOf,failedItems");
    expect(lines[1]).toContain('"odd, name (quote "" inside)"');
    expect(lines[1]).toContain("Alice");
    expect(lines[1]).toContain("delete");
  });

  it("formats Markdown with a header, separator, and pipe-safe cells", () => {
    const markdown = formatBatchOperationMarkdown([makeRecord()]);
    const lines = markdown.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("| Id | Started | Action |");
    expect(lines[1]).toMatch(/^\| --- \|/);
    expect(lines[2]).toContain("1/3 ok, 1 failed, 1 skipped");
    expect(lines[2]).toContain("alpha-02 (network reset)");
  });

  it("escapes pipes and newlines in Markdown cells and leaves non-failed records without failed details", () => {
    const markdown = formatBatchOperationMarkdown([
      makeRecord({ id: "batch|2", items: [{ key: "1", name: "ok-name", status: "succeeded" }], summary: { total: 1, succeeded: 1, failed: 0, skipped: 0, unknown: 0 } }),
    ]);
    expect(markdown).toContain("batch\\|2");
    expect(markdown).toContain("|  |  |");
  });

  it("keeps retry linkage and the account key fallback in every format", () => {
    const record = makeRecord({ retryOf: "batch-0", accountDisplayName: "", items: [{ key: "1", name: "retry-me", status: "failed", error: "boom" }], summary: { total: 1, succeeded: 0, failed: 1, skipped: 0, unknown: 0 } });
    expect((JSON.parse(formatBatchOperationExport([record])) as { items: Array<{ retryOf?: string }> }).items[0].retryOf).toBe("batch-0");
    expect(formatBatchOperationCsv([record])).toContain("alice@116.172.93.164:28080");
    expect(formatBatchOperationMarkdown([record])).toContain("retry-me (boom)");
  });
});
