import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Task } from "../lib/types";
import { MoreActionsMenu } from "./TasksPage";

describe("MoreActionsMenu", () => {
  const task = { id: 1, name: "长任务", status: 2 } as Task;
  const defaultProps = {
    onCommit: vi.fn(),
    onDownload: vi.fn(),
    onRaw: vi.fn(),
    onSaveTemplate: vi.fn(),
  };

  it("supports keyboard navigation and restores focus on Escape", async () => {
    render(<MoreActionsMenu task={task} {...defaultProps} />);

    const trigger = screen.getByRole("button");
    fireEvent.click(trigger);

    const items = await screen.findAllByRole("menuitem");
    const [download, commit, saveTemplate, raw] = items;

    await waitFor(() => expect(download).toHaveFocus());

    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(commit).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(saveTemplate).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(raw).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
    expect(saveTemplate).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("opens from keyboard and focuses the last item on ArrowUp", async () => {
    render(<MoreActionsMenu task={task} {...defaultProps} />);

    const trigger = screen.getByRole("button");
    fireEvent.keyDown(trigger, { key: "ArrowUp" });

    const items = await screen.findAllByRole("menuitem");
    const raw = items[3];
    await waitFor(() => expect(raw).toHaveFocus());
  });

  it("calls commit for running tasks and disables it otherwise", async () => {
    const onCommit = vi.fn();
    const { rerender } = render(<MoreActionsMenu task={task} {...defaultProps} onCommit={onCommit} />);

    fireEvent.click(screen.getByRole("button"));
    let items = await screen.findAllByRole("menuitem");
    fireEvent.click(items[1]);
    expect(onCommit).toHaveBeenCalledWith(task);

    const stoppedTask = { ...task, status: 6 };
    rerender(<MoreActionsMenu task={stoppedTask} {...defaultProps} onCommit={onCommit} />);
    fireEvent.click(screen.getByRole("button"));
    items = await screen.findAllByRole("menuitem");
    expect(items[1]).toBeDisabled();
  });
});
