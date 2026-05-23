import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MoreActionsMenu } from "./TasksPage";
import type { Task } from "../lib/types";

describe("MoreActionsMenu", () => {
  const task = { id: 1, name: "长任务" } as Task;

  it("supports keyboard navigation and restores focus on Escape", async () => {
    render(<MoreActionsMenu task={task} onDownload={vi.fn()} onRaw={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: "更多操作 长任务" });
    fireEvent.click(trigger);

    const download = await screen.findByRole("menuitem", { name: "下载" });
    const raw = screen.getByRole("menuitem", { name: "原始 JSON" });

    await waitFor(() => expect(download).toHaveFocus());

    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(raw).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
    expect(download).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("opens from keyboard and focuses the last item on ArrowUp", async () => {
    render(<MoreActionsMenu task={task} onDownload={vi.fn()} onRaw={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: "更多操作 长任务" });
    fireEvent.keyDown(trigger, { key: "ArrowUp" });

    const raw = await screen.findByRole("menuitem", { name: "原始 JSON" });
    await waitFor(() => expect(raw).toHaveFocus());
  });
});
