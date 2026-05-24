import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "./ConfirmDialog";
import { Button, Dialog } from "./ui";

describe("ConfirmDialog", () => {
  it("runs confirm action and exposes cancel", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        options={{ title: "确认删除", description: "删除实例", confirmLabel: "删除", tone: "danger", run: vi.fn() }}
        pending={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("Dialog", () => {
  it("closes on Escape and restores focus", async () => {
    function DialogHarness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <Button onClick={() => setOpen(true)}>打开按钮</Button>
          <Dialog open={open} title="示例" onClose={() => setOpen(false)}>
            <button type="button">内部按钮</button>
          </Dialog>
        </div>
      );
    }

    render(
      <DialogHarness />,
    );
    const trigger = screen.getByRole("button", { name: "打开按钮" });
    trigger.focus();
    fireEvent.click(trigger);

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("keeps Tab focus inside the dialog", async () => {
    render(
      <Dialog open title="焦点测试" onClose={vi.fn()}>
        <button type="button">第一个</button>
        <button type="button">最后一个</button>
      </Dialog>,
    );

    const close = screen.getByRole("button", { name: "关闭" });
    const last = screen.getByRole("button", { name: "最后一个" });

    await waitFor(() => expect(close).toHaveFocus());

    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(close).toHaveFocus();

    close.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });

  it("renders outside animated page containers so the overlay covers the viewport", () => {
    const { container } = render(
      <div className="app-page-enter" data-testid="page-shell">
        <Dialog open title="Portal" onClose={vi.fn()}>
          <button type="button">Inside</button>
        </Dialog>
      </div>,
    );

    const dialog = screen.getByRole("dialog");
    expect(container).not.toContainElement(dialog);
    expect(document.body).toContainElement(dialog);
  });
});
