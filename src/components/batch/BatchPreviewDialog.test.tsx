import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../../lib/i18n";
import { BatchPreviewDialog, type BatchPreviewItem } from "./BatchPreviewDialog";

const items: BatchPreviewItem[] = [
  { key: "101", name: "alpha-01", meta: "运行中 · 4C/16G", irreversible: true },
  { key: "102", name: "alpha-02" },
  { key: "103", name: "beta-07", meta: "已结束" },
];

function renderDialog(overrides: Partial<Parameters<typeof BatchPreviewDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  const props: Parameters<typeof BatchPreviewDialog>[0] = {
    open: true,
    title: "确认批量删除",
    tone: "default",
    items,
    account: { displayName: "Alice" },
    confirmLabel: "批量删除",
    onConfirm,
    onClose,
    ...overrides,
  };
  const view = render(
    <I18nProvider>
      <BatchPreviewDialog {...props} />
    </I18nProvider>,
  );
  return { onConfirm, onClose, unmount: view.unmount };
}

describe("BatchPreviewDialog", () => {
  it("renders the item list with names and meta summaries while keeping keys out of the DOM", () => {
    renderDialog();

    const dialog = screen.getByRole("dialog");
    const region = within(dialog).getByRole("region", { name: /影响清单|Impact list/ });
    expect(within(region).getByText("alpha-01")).toBeInTheDocument();
    expect(within(region).getByText("运行中 · 4C/16G")).toBeInTheDocument();
    expect(within(region).getByText("beta-07")).toBeInTheDocument();
    expect(within(region).queryByText("101")).not.toBeInTheDocument();
    // Empty meta and flag cells stay blank instead of a "-" placeholder that reads as a value.
    expect(within(region).queryByText("-")).not.toBeInTheDocument();
  });

  it("flags irreversible items in text when only some are irreversible", () => {
    renderDialog({ tone: "danger" });

    const dialog = screen.getByRole("dialog");
    const region = within(dialog).getByRole("region", { name: /影响清单|Impact list/ });
    expect(within(region).getByRole("columnheader", { name: /标记|Flag/ })).toBeInTheDocument();
    const row = within(dialog).getByText("alpha-01").closest("tr") as HTMLElement;
    expect(within(row).getByText(/不可逆|Irreversible/)).toBeInTheDocument();
    expect(within(dialog).getByText(/其中 1 项提交后无法撤销|1 item is irreversible/)).toBeInTheDocument();
  });

  it("states irreversibility once, without a flag column, when every item is irreversible", () => {
    renderDialog({ tone: "danger", items: items.map((item) => ({ ...item, irreversible: true })) });

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("columnheader", { name: /标记|Flag/ })).not.toBeInTheDocument();
    expect(within(dialog).getByText(/以下 3 项提交后都无法从 EasyConsole 撤销|cannot undo any of these 3 items/)).toBeInTheDocument();
  });

  it("renders the aggregate summary above the list", () => {
    renderDialog({ summary: <p>将释放 3 个实例</p> });

    expect(screen.getByText("将释放 3 个实例")).toBeInTheDocument();
  });

  it("shows the current account display name and the item count", () => {
    renderDialog();

    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText(/共 3 项|3 items/)).toBeInTheDocument();
  });

  it("invokes onConfirm once from the confirm button and keeps onClose separate", () => {
    const { onConfirm, onClose } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "批量删除" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("styles the confirm button with the danger variant only for danger tone", () => {
    const { unmount } = renderDialog({ tone: "danger" });
    expect(screen.getByRole("button", { name: "批量删除" }).className).toContain("bg-app-danger");
    unmount();

    renderDialog({ tone: "default" });
    expect(screen.getByRole("button", { name: "批量删除" }).className).not.toContain("bg-app-danger");
  });

  it("disables the confirm button when the item list is empty", () => {
    const { onConfirm } = renderDialog({ items: [] });

    const confirmButton = screen.getByRole("button", { name: "批量删除" });
    expect(confirmButton).toBeDisabled();
    expect(screen.getByText(/没有待提交的条目|No items to submit/)).toBeInTheDocument();

    fireEvent.click(confirmButton);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("disables confirm and cancel while pending", () => {
    renderDialog({ pending: true });

    expect(screen.getByRole("button", { name: "批量删除" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /取消|Cancel/ })).toBeDisabled();
  });
});
