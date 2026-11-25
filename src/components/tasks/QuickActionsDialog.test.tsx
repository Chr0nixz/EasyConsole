import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_TASK_QUICK_ACTIONS, type TaskQuickActionId } from "../../lib/task-quick-actions";
import { QuickActionsDialog } from "./QuickActionsDialog";

function Harness({ initial, onChange }: { initial: TaskQuickActionId[]; onChange?: (next: TaskQuickActionId[]) => void }) {
  const [actions, setActions] = useState(initial);
  return (
    <QuickActionsDialog
      open
      actions={actions}
      onChange={(next) => {
        onChange?.(next);
        setActions(next);
      }}
      onClose={vi.fn()}
    />
  );
}

function barItems() {
  return within(screen.getByRole("list", { name: /操作栏上|On the bar/ })).getAllByRole("listitem").map((item) => item.textContent ?? "");
}

describe("QuickActionsDialog", () => {
  it("lists the bar in order and everything else as addable", () => {
    render(<Harness initial={[...DEFAULT_TASK_QUICK_ACTIONS]} />);

    expect(screen.getByRole("dialog", { name: /自定义操作栏|Customize action bar/ })).toHaveAccessibleDescription(/释放|Release/);
    expect(barItems()).toEqual([
      expect.stringMatching(/终端|Terminal/),
      expect.stringMatching(/日志|Logs/),
      expect.stringMatching(/克隆|Clone/),
    ]);
    expect(screen.getByRole("button", { name: /添加 监控 到操作栏|Add Monitor to the bar/ })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /添加 终端 到操作栏|Add Terminal to the bar/ })).not.toBeInTheDocument();
  });

  it("moves an action and keeps focus on it, falling back to the arrow that can still move", async () => {
    const onChange = vi.fn();
    render(<Harness initial={["terminal", "log", "clone"]} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /上移 日志|Move Logs up/ }));
    expect(onChange).toHaveBeenLastCalledWith(["log", "terminal", "clone"]);
    expect(barItems()[0]).toMatch(/日志|Logs/);
    // At the top the up arrow is disabled, so focus lands on its down arrow instead.
    expect(screen.getByRole("button", { name: /上移 日志|Move Logs up/ })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("button", { name: /下移 日志|Move Logs down/ })).toHaveFocus());
  });

  it("adds and removes, following the action between the two lists", async () => {
    const onChange = vi.fn();
    render(<Harness initial={["terminal"]} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /添加 原始 JSON 到操作栏|Add Raw JSON to the bar/ }));
    expect(onChange).toHaveBeenLastCalledWith(["terminal", "raw"]);
    const remove = await screen.findByRole("button", { name: /从操作栏移除 原始 JSON|Remove Raw JSON from the bar/ });
    await waitFor(() => expect(remove).toHaveFocus());

    fireEvent.click(remove);
    expect(onChange).toHaveBeenLastCalledWith(["terminal"]);
    await waitFor(() => expect(screen.getByRole("button", { name: /添加 原始 JSON 到操作栏|Add Raw JSON to the bar/ })).toHaveFocus());
  });

  it("explains the limit when the bar is full, and restores the defaults", () => {
    const onChange = vi.fn();
    render(<Harness initial={["terminal", "log", "monitor", "clone", "extend", "edit"]} onChange={onChange} />);

    const add = screen.getByRole("button", { name: /添加 下载 到操作栏|Add Download to the bar/ });
    // Still focusable, with the reason as its description.
    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(add).toHaveAccessibleDescription(/最多 6 个|Up to 6/);
    fireEvent.click(add);
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /恢复默认|Restore defaults/ }));
    expect(onChange).toHaveBeenLastCalledWith([...DEFAULT_TASK_QUICK_ACTIONS]);
  });

  it("says what an empty bar leaves on each row", () => {
    render(<Harness initial={[]} />);
    expect(screen.getByText(/只显示释放和「更多」|only Release and More/)).toBeInTheDocument();
  });
});
