import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../../lib/i18n";
import { ToastProvider } from "../Toast";
import type { ExecutionLedgerEntry } from "../../lib/execution-ledger";
import { ExecutionLedgerPanel } from "./ExecutionLedgerPanel";

const ledgerMocks = vi.hoisted(() => ({
  list: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("../../lib/execution-ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/execution-ledger")>()),
  listExecutionLedger: ledgerMocks.list,
  resolveExecutionLedgerEntry: ledgerMocks.resolve,
}));

const entryCompleted: ExecutionLedgerEntry = {
  id: "entry-1",
  scheduledTaskId: "schedule-1",
  scheduledTaskName: "nightly-train",
  trigger: "schedule",
  accountKey: "alice@116.172.93.164:28080",
  accountDisplayName: "Alice",
  startedAt: "2026-10-24T08:00:00.000Z",
  finishedAt: "2026-10-24T08:00:05.000Z",
  remoteTaskId: "10001",
  outcome: "completed",
};

const entryUnknown: ExecutionLedgerEntry = {
  id: "entry-2",
  scheduledTaskId: "schedule-2",
  scheduledTaskName: "dawn-eval",
  trigger: "manual",
  accountKey: "alice@116.172.93.164:28080",
  accountDisplayName: "Alice",
  startedAt: "2026-10-24T07:00:00.000Z",
  outcome: "unknown",
  error: "Remote create accepted but the local write failed",
};

const entryPersistFailed: ExecutionLedgerEntry = {
  id: "entry-3",
  scheduledTaskId: "schedule-3",
  scheduledTaskName: "cleanup-job",
  trigger: "cli",
  accountKey: "alice@116.172.93.164:28080",
  accountDisplayName: "Alice",
  startedAt: "2026-10-24T06:00:00.000Z",
  remoteTaskId: "10023",
  outcome: "local-persist-failed",
  error: "storage write failed",
};

function renderLedger() {
  render(
    <I18nProvider>
      <ToastProvider>
        <ExecutionLedgerPanel />
      </ToastProvider>
    </I18nProvider>,
  );
}

function historyRegion() {
  return within(screen.getByRole("region", { name: /Execution ledger records|执行台账记录/ }));
}

describe("ExecutionLedgerPanel", () => {
  beforeEach(() => {
    ledgerMocks.list.mockReset();
    ledgerMocks.resolve.mockReset();
    ledgerMocks.list.mockResolvedValue([entryCompleted, entryUnknown, entryPersistFailed]);
    ledgerMocks.resolve.mockResolvedValue(undefined);
  });

  it("renders the ledger list and aggregates uncertain outcomes into the review section", async () => {
    renderLedger();

    expect(await screen.findByText("nightly-train")).toBeInTheDocument();
    expect(screen.getByText(/Needs review \(2\)|待核对（2）/)).toBeInTheDocument();
    // Uncertain entries appear both in the review section and the history table.
    expect(screen.getAllByText("dawn-eval").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("cleanup-job").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Unknown result|结果未知/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Local save failed|本地保存失败/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Completed|已完成/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("10023").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("storage write failed").length).toBeGreaterThanOrEqual(1);
  });

  it("filters the history list by outcome", async () => {
    renderLedger();

    expect(await screen.findByText("nightly-train")).toBeInTheDocument();
    const region = historyRegion();
    expect(region.getByText("nightly-train")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: /Filter by outcome|按结果筛选/ }), { target: { value: "unknown" } });

    expect(region.getByText("dawn-eval")).toBeInTheDocument();
    expect(region.queryByText("nightly-train")).not.toBeInTheDocument();
    expect(region.queryByText("cleanup-job")).not.toBeInTheDocument();
  });

  it("filters the history list to entries needing review", async () => {
    renderLedger();

    expect(await screen.findByText("nightly-train")).toBeInTheDocument();
    const region = historyRegion();

    fireEvent.change(screen.getByRole("combobox", { name: /Filter by outcome|按结果筛选/ }), { target: { value: "needs-review" } });

    expect(region.getByText("dawn-eval")).toBeInTheDocument();
    expect(region.getByText("cleanup-job")).toBeInTheDocument();
    expect(region.queryByText("nightly-train")).not.toBeInTheDocument();
  });

  it("confirms a run was created remotely with an optional remote id note, then moves it out of review", async () => {
    const resolvedUnknown: ExecutionLedgerEntry = {
      ...entryUnknown,
      resolution: { status: "confirmed-created", resolvedAt: "2026-10-24T09:00:00.000Z", note: "10077" },
    };
    ledgerMocks.list.mockResolvedValueOnce([entryCompleted, entryUnknown, entryPersistFailed]);
    ledgerMocks.list.mockResolvedValueOnce([entryCompleted, resolvedUnknown, entryPersistFailed]);
    renderLedger();

    const row = await screen.findAllByText("dawn-eval").then((nodes) => nodes[0].closest("li"));
    expect(row).not.toBeNull();
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: /Confirm created|确认已创建/ }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Remote task ID|远程任务 ID/ }), { target: { value: "10077" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Confirmed created|确认已创建/ }));

    await waitFor(() =>
      expect(ledgerMocks.resolve).toHaveBeenCalledWith(
        expect.anything(),
        "entry-2",
        expect.objectContaining({ status: "confirmed-created", note: "10077" }),
      ),
    );
    expect(await screen.findByText(/Needs review \(1\)|待核对（1）/)).toBeInTheDocument();
    const region = historyRegion();
    expect(region.getByText("dawn-eval")).toBeInTheDocument();
    expect(region.getByText(/Verified: created|已核对：已创建/)).toBeInTheDocument();
  });

  it("confirms a run was not created and reloads the ledger", async () => {
    ledgerMocks.resolve.mockResolvedValue({
      ...entryPersistFailed,
      resolution: { status: "confirmed-not-created", resolvedAt: "2026-10-24T09:00:00.000Z" },
    });
    renderLedger();

    const row = await screen.findAllByText("cleanup-job").then((nodes) => nodes[0].closest("li"));
    expect(row).not.toBeNull();
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: /Confirm not created|确认未创建/ }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Confirmed not created|确认未创建/ }));

    await waitFor(() =>
      expect(ledgerMocks.resolve).toHaveBeenCalledWith(
        expect.anything(),
        "entry-3",
        expect.objectContaining({ status: "confirmed-not-created" }),
      ),
    );
    await waitFor(() => expect(ledgerMocks.list).toHaveBeenCalledTimes(2));
  });
});
