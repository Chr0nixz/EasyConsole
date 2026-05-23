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
});
