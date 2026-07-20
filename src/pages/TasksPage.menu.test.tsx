import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Task } from "../lib/types";
import { MoreActionsMenu } from "./TasksPage";

describe("MoreActionsMenu", () => {
  const task = { id: 1, name: "长任务", status: 2 } as Task;
  const defaultProps = {
    canEdit: false,
    isPinned: false,
    onClone: vi.fn(),
    onCommit: vi.fn(),
    onDownload: vi.fn(),
    onEdit: vi.fn(),
    onLog: vi.fn(),
    onRaw: vi.fn(),
    onSaveTemplate: vi.fn(),
    onSshInfo: vi.fn(),
    onTogglePin: vi.fn(),
  };

  it("supports keyboard navigation across grouped sections and restores focus on Escape", async () => {
    render(<MoreActionsMenu task={task} {...defaultProps} />);

    const trigger = screen.getByRole("button");
    fireEvent.click(trigger);

    const items = await screen.findAllByRole("menuitem");
    expect(items).toHaveLength(8);
    expect(screen.getAllByRole("separator")).toHaveLength(2);

    await waitFor(() => expect(items[0]).toHaveFocus());

    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "End" });
    expect(items[items.length - 1]).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("opens from keyboard and focuses the last item on ArrowUp", async () => {
    render(<MoreActionsMenu task={task} {...defaultProps} />);

    const trigger = screen.getByRole("button");
    fireEvent.keyDown(trigger, { key: "ArrowUp" });

    const items = await screen.findAllByRole("menuitem");
    const raw = items[items.length - 1];
    await waitFor(() => expect(raw).toHaveFocus());
  });

  it("calls toggle pin from the collapsed menu", async () => {
    const onTogglePin = vi.fn();
    render(<MoreActionsMenu task={task} {...defaultProps} onTogglePin={onTogglePin} />);

    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Pin|置顶/ }));
    expect(onTogglePin).toHaveBeenCalledWith(task);
  });

  it("shows unpin label when the task is pinned", async () => {
    render(<MoreActionsMenu task={task} {...defaultProps} isPinned />);

    fireEvent.click(screen.getByRole("button"));
    expect(await screen.findByRole("menuitem", { name: /Unpin|取消置顶/ })).toBeInTheDocument();
  });

  it("calls commit for running tasks and disables it otherwise", async () => {
    const onCommit = vi.fn();
    const { rerender } = render(<MoreActionsMenu task={task} {...defaultProps} onCommit={onCommit} />);

    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Commit image|提交镜像/ }));
    expect(onCommit).toHaveBeenCalledWith(task);

    rerender(<MoreActionsMenu task={{ ...task, status: 1 }} {...defaultProps} onCommit={onCommit} />);
    fireEvent.click(screen.getByRole("button"));
    expect(await screen.findByRole("menuitem", { name: /Commit image|提交镜像/ })).toBeDisabled();
  });

  it("exposes monitor in More when logs are promoted for failed tasks", async () => {
    const onMonitor = vi.fn();
    render(
      <MoreActionsMenu
        task={{ ...task, status: 7 }}
        {...defaultProps}
        promoteLog
        onMonitor={onMonitor}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    const items = await screen.findAllByRole("menuitem");
    expect(items).toHaveLength(9);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Monitor|监控/ }));
    expect(onMonitor).toHaveBeenCalledWith({ ...task, status: 7 });
  });

  it("keeps logs first in the toolbox and exposes connection info", async () => {
    const onClone = vi.fn();
    const onSshInfo = vi.fn();
    const onLog = vi.fn();
    render(
      <MoreActionsMenu
        task={task}
        {...defaultProps}
        onClone={onClone}
        onLog={onLog}
        onSshInfo={onSshInfo}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    const items = await screen.findAllByRole("menuitem");
    expect(items[0]).toHaveTextContent(/Logs|日志/);
    expect(items[1]).toHaveTextContent(/Connection info|连接信息/);
    expect(items[2]).toHaveTextContent(/Clone|克隆/);

    fireEvent.click(await screen.findByRole("menuitem", { name: /Logs|日志/ }));
    expect(onLog).toHaveBeenCalledWith(task);

    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Clone|克隆/ }));
    expect(onClone).toHaveBeenCalledWith(task);

    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Connection info|连接信息/ }));
    expect(onSshInfo).toHaveBeenCalledWith(task);
  });

  it("hides connection info when the primary action already exposes it", async () => {
    render(<MoreActionsMenu task={task} {...defaultProps} showSshInfo={false} />);

    fireEvent.click(screen.getByRole("button"));
    const items = await screen.findAllByRole("menuitem");
    expect(items).toHaveLength(7);
    expect(screen.queryByRole("menuitem", { name: /Connection info|连接信息/ })).not.toBeInTheDocument();
    expect(items[0]).toHaveTextContent(/Logs|日志/);
    expect(items[1]).toHaveTextContent(/Clone|克隆/);
  });
});
