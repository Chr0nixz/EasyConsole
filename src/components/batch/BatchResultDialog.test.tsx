import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { BatchRunResult } from "../../lib/batch-runner";
import { I18nProvider } from "../../lib/i18n";
import { BatchResultDialog, type PreviewItem } from "./BatchResultDialog";

function makeResult(overrides: Partial<BatchRunResult<PreviewItem>> = {}): BatchRunResult<PreviewItem> {
  return {
    outcomes: [
      { item: { key: "1", name: "alpha-01", meta: "4C/16G" }, status: "succeeded" },
      { item: { key: "2", name: "alpha-02" }, status: "failed", error: "network reset" },
      { item: { key: "3", name: "alpha-03" }, status: "skipped" },
      { item: { key: "4", name: "alpha-04" }, status: "succeeded" },
    ],
    summary: { total: 4, succeeded: 2, failed: 1, skipped: 1 },
    ...overrides,
  };
}

function renderDialog(result: BatchRunResult<PreviewItem>, overrides: Partial<Parameters<typeof BatchResultDialog>[0]> = {}) {
  const onRetryFailed = vi.fn();
  const onExport = vi.fn();
  const onClose = vi.fn();
  const props: Parameters<typeof BatchResultDialog>[0] = {
    open: true,
    title: "批量结果",
    result,
    onRetryFailed,
    onExport,
    onClose,
    ...overrides,
  };
  const view = render(
    <I18nProvider>
      <BatchResultDialog {...props} />
    </I18nProvider>,
  );
  return { onRetryFailed, onExport, onClose, unmount: view.unmount };
}

function resultRegion() {
  return within(screen.getByRole("region", { name: /逐项结果|Per-item results/ }));
}

describe("BatchResultDialog", () => {
  it("renders per-item status badges, error text, and the summary line", () => {
    renderDialog(makeResult());

    const region = resultRegion();
    const failedRow = within(region.getByText("alpha-02").closest("tr") as HTMLElement);
    expect(failedRow.getByText(/失败|Failed/)).toBeInTheDocument();
    expect(failedRow.getByText("network reset")).toBeInTheDocument();

    const okRow = within(region.getByText("alpha-01").closest("tr") as HTMLElement);
    expect(okRow.getByText(/成功|Succeeded/)).toBeInTheDocument();
    expect(okRow.getByText("4C/16G")).toBeInTheDocument();

    expect(region.getByText("alpha-03").closest("tr")).toHaveTextContent(/已跳过|Skipped/);
    expect(screen.getByTestId("batch-result-summary")).toHaveTextContent(/共 4 项|4 items/);
    expect(screen.getByTestId("batch-result-summary")).toHaveTextContent(/成功 2 · 失败 1 · 跳过 1|2 succeeded · 1 failed · 1 skipped/);
  });

  it("offers the retry button only after the run finishes with failures", () => {
    const { onRetryFailed, unmount } = renderDialog(makeResult());
    const retry = screen.getByRole("button", { name: /重试失败项 \(1\)|Retry failed \(1\)/ });
    fireEvent.click(retry);
    expect(onRetryFailed).toHaveBeenCalledTimes(1);
    unmount();

    // While pending, the retry entry stays hidden even with failures.
    const pendingView = render(
      <I18nProvider>
        <BatchResultDialog open title="批量结果" result={makeResult()} pending onRetryFailed={vi.fn()} onClose={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.queryByRole("button", { name: /重试失败项|Retry failed/ })).not.toBeInTheDocument();
    pendingView.unmount();

    // A fully successful run has nothing to retry.
    renderDialog(makeResult({ outcomes: makeResult().outcomes.filter((outcome) => outcome.status !== "failed"), summary: { total: 3, succeeded: 2, failed: 0, skipped: 1 } }), { onRetryFailed: undefined });
    expect(screen.queryByRole("button", { name: /重试失败项|Retry failed/ })).not.toBeInTheDocument();
  });

  it("exports through the dropdown menu in all three formats and closes the menu after choosing", () => {
    const { onExport } = renderDialog(makeResult());

    fireEvent.click(screen.getByRole("button", { name: /导出|Export/ }));
    const menu = screen.getByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "JSON" }));
    expect(onExport).toHaveBeenNthCalledWith(1, "json");

    fireEvent.click(screen.getByRole("button", { name: /导出|Export/ }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "CSV" }));
    expect(onExport).toHaveBeenNthCalledWith(2, "csv");

    fireEvent.click(screen.getByRole("button", { name: /导出|Export/ }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Markdown" }));
    expect(onExport).toHaveBeenNthCalledWith(3, "md");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("shows progress while pending and offers the background escape hatch instead of close", () => {
    const { onClose } = renderDialog(
      makeResult({ outcomes: makeResult().outcomes.slice(0, 2), summary: { total: 4, succeeded: 1, failed: 1, skipped: 0 } }),
      { pending: true, onExport: undefined, onRetryFailed: undefined },
    );

    expect(screen.getByTestId("batch-result-summary")).toHaveTextContent(/进行中 2\/4|In progress 2\/4/);
    fireEvent.click(screen.getByRole("button", { name: /后台运行|Run in background/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders the empty state before the first outcome lands", () => {
    renderDialog(makeResult({ outcomes: [], summary: { total: 3, succeeded: 0, failed: 0, skipped: 0 } }), { pending: true });

    expect(screen.getByText(/还没有已完成的条目|No items have finished yet/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /逐项结果|Per-item results/ })).not.toBeInTheDocument();
  });
});
