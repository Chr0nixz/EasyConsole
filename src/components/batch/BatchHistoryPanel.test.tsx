import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../../lib/i18n";
import type { BatchOperationRecord } from "../../lib/change-list";
import { BatchHistoryPanel } from "./BatchHistoryPanel";

const historyMocks = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../../lib/change-list", () => ({
  listBatchOperations: historyMocks.list,
}));

const recordDeleteWithFailures: BatchOperationRecord = {
  id: "batch-1",
  action: "delete",
  trigger: "ui",
  accountKey: "alice@116.172.93.164:28080",
  accountDisplayName: "Alice",
  startedAt: "2026-10-24T08:00:00.000Z",
  finishedAt: "2026-10-24T08:00:04.000Z",
  items: [
    { key: "101", name: "alpha-01", status: "failed", error: "network reset" },
    { key: "102", name: "alpha-02", status: "succeeded", remoteTaskId: "102" },
    { key: "103", name: "alpha-03", status: "skipped" },
  ],
  summary: { total: 3, succeeded: 1, failed: 1, skipped: 1 },
};

const recordCreateAllSucceeded: BatchOperationRecord = {
  id: "batch-2",
  action: "create",
  trigger: "ui",
  accountKey: "alice@116.172.93.164:28080",
  accountDisplayName: "Alice",
  startedAt: "2026-10-24T07:00:00.000Z",
  finishedAt: "2026-10-24T07:00:02.000Z",
  items: [
    { key: "0", name: "train-a", status: "succeeded", remoteTaskId: "201" },
    { key: "1", name: "train-b", status: "succeeded", remoteTaskId: "202" },
  ],
  summary: { total: 2, succeeded: 2, failed: 0, skipped: 0 },
};

const recordRetry: BatchOperationRecord = {
  id: "batch-3",
  action: "delete",
  trigger: "ui",
  accountKey: "alice@116.172.93.164:28080",
  accountDisplayName: "Alice",
  startedAt: "2026-10-24T08:05:00.000Z",
  finishedAt: "2026-10-24T08:05:01.000Z",
  items: [{ key: "101", name: "alpha-01", status: "succeeded", remoteTaskId: "101" }],
  summary: { total: 1, succeeded: 1, failed: 0, skipped: 0 },
  retryOf: "batch-1",
};

function renderPanel(refreshSignal?: string) {
  render(
    <I18nProvider>
      <BatchHistoryPanel refreshSignal={refreshSignal} />
    </I18nProvider>,
  );
}

async function recordsList() {
  return within(await screen.findByRole("list", { name: /批量操作记录|Batch operation records/ }));
}

describe("BatchHistoryPanel", () => {
  beforeEach(() => {
    historyMocks.list.mockReset();
    historyMocks.list.mockResolvedValue([recordRetry, recordDeleteWithFailures, recordCreateAllSucceeded]);
  });

  it("renders records with time, action, account, and outcome summary; expands per-item failures", async () => {
    renderPanel();

    const list = await recordsList();
    expect(list.getAllByText(/批量删除|Batch delete/).length).toBe(2);
    expect(list.getByText(/批量创建|Batch create/)).toBeInTheDocument();
    expect(list.getAllByText(/Alice/).length).toBeGreaterThan(0);
    expect(list.getByText(/失败 1\/3|Failed 1\/3/)).toBeInTheDocument();
    expect(list.getByText(/成功 2\/2|Succeeded 2\/2/)).toBeInTheDocument();

    // Expand the failed delete record: item rows with reasons and the retry hint.
    const failedRecordRow = list.getByText(/失败 1\/3|Failed 1\/3/).closest("li") as HTMLElement;
    fireEvent.click(within(failedRecordRow).getByRole("button", { name: /展开|Expand/ }));
    expect(within(failedRecordRow).getByText("alpha-01")).toBeInTheDocument();
    expect(within(failedRecordRow).getByText("network reset")).toBeInTheDocument();
    expect(within(failedRecordRow).getByText(/失败项不会自动重放|Failed items are never replayed/)).toBeInTheDocument();
  });

  it("filters records by action", async () => {
    renderPanel();

    await recordsList();
    fireEvent.change(screen.getByRole("combobox", { name: /按动作筛选|Filter by action/ }), { target: { value: "create" } });

    const list = await recordsList();
    expect(list.getByText(/批量创建|Batch create/)).toBeInTheDocument();
    expect(list.queryByText(/批量删除|Batch delete/)).not.toBeInTheDocument();
  });

  it("filters records by result", async () => {
    renderPanel();

    await recordsList();
    fireEvent.change(screen.getByRole("combobox", { name: /按结果筛选|Filter by result/ }), { target: { value: "with-failures" } });

    const list = await recordsList();
    expect(list.getByText(/失败 1\/3|Failed 1\/3/)).toBeInTheDocument();
    expect(list.queryByText(/批量创建|Batch create/)).not.toBeInTheDocument();
    // The all-succeeded retry record (batch-3) is excluded by this filter.
    expect(list.queryByText(/重试自|Retry of/)).not.toBeInTheDocument();
  });

  it("shows the retryOf linkage on retry records", async () => {
    renderPanel();

    const list = await recordsList();
    // Points at the original run by when it ran; the raw id stays in the tooltip.
    const retryBadge = list.getByText(/重试自 .+ 的操作|Retry of the run at/).closest("span") as HTMLElement;
    expect(retryBadge).toHaveAttribute("title", "batch-1");
    expect(within(retryBadge).queryByText("batch-1")).not.toBeInTheDocument();
  });

  it("collapses to just the header and reloads when the refresh signal changes", async () => {
    const { rerender } = render(
      <I18nProvider>
        <BatchHistoryPanel refreshSignal="batch-a" />
      </I18nProvider>,
    );
    await recordsList();

    fireEvent.click(screen.getByRole("button", { name: /最近批量操作|Recent batch operations/ }));
    expect(screen.queryByRole("list", { name: /批量操作记录|Batch operation records/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /最近批量操作|Recent batch operations/ })).toHaveAttribute("aria-expanded", "false");

    historyMocks.list.mockClear();
    historyMocks.list.mockResolvedValueOnce([recordRetry]);
    rerender(
      <I18nProvider>
        <BatchHistoryPanel refreshSignal="batch-b" />
      </I18nProvider>,
    );
    await waitFor(() => expect(historyMocks.list).toHaveBeenCalled());
  });
});
