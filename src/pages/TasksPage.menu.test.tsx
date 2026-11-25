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

  it("leaves logs out of More when they are on the row, and offers monitor", async () => {
    const onMonitor = vi.fn();
    render(
      <MoreActionsMenu
        task={{ ...task, status: 7 }}
        {...defaultProps}
        stripActions={["log"]}
        onMonitor={onMonitor}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    const items = await screen.findAllByRole("menuitem");
    expect(items).toHaveLength(8);
    expect(screen.queryByRole("menuitem", { name: /Logs|日志/ })).not.toBeInTheDocument();
    expect(items[0]).toHaveTextContent(/Monitor|监控/);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Monitor|监控/ }));
    expect(onMonitor).toHaveBeenCalledWith({ ...task, status: 7 });
  });

  it("omits the default bar's terminal, log and clone from More", async () => {
    const onMonitor = vi.fn();
    render(
      <MoreActionsMenu
        task={task}
        {...defaultProps}
        stripActions={["terminal", "log", "clone"]}
        onMonitor={onMonitor}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    const items = await screen.findAllByRole("menuitem");
    expect(items).toHaveLength(6);
    expect(screen.queryByRole("menuitem", { name: /Clone|克隆/ })).not.toBeInTheDocument();
    expect(items[0]).toHaveTextContent(/Monitor|监控/);
    expect(items[1]).toHaveTextContent(/Commit image|提交镜像/);
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
    expect(items[1]).toHaveTextContent(/Terminal|终端/);
    expect(items[2]).toHaveTextContent(/Clone|克隆/);

    fireEvent.click(await screen.findByRole("menuitem", { name: /Logs|日志/ }));
    expect(onLog).toHaveBeenCalledWith(task);

    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Clone|克隆/ }));
    expect(onClone).toHaveBeenCalledWith(task);

    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Terminal|终端/ }));
    expect(onSshInfo).toHaveBeenCalledWith(task);
  });

  it("hides connection info when the primary action already exposes it", async () => {
    render(<MoreActionsMenu task={task} {...defaultProps} stripActions={["terminal"]} />);

    fireEvent.click(screen.getByRole("button"));
    const items = await screen.findAllByRole("menuitem");
    expect(items).toHaveLength(7);
    expect(screen.queryByRole("menuitem", { name: /Terminal|终端/ })).not.toBeInTheDocument();
    expect(items[0]).toHaveTextContent(/Logs|日志/);
    expect(items[1]).toHaveTextContent(/Clone|克隆/);
  });

  it("offers delete only for ended tasks, as a separate last item", async () => {
    const onDelete = vi.fn();
    const ended = { ...task, status: 6 } as Task;
    const { unmount } = render(<MoreActionsMenu task={ended} {...defaultProps} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole("button"));
    const items = await screen.findAllByRole("menuitem");
    expect(items[items.length - 1]).toHaveTextContent(/Delete instance|删除实例/);
    fireEvent.click(items[items.length - 1]);
    expect(onDelete).toHaveBeenCalledWith(ended);
    unmount();

    render(<MoreActionsMenu task={task} {...defaultProps} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button"));
    await screen.findAllByRole("menuitem");
    expect(screen.queryByRole("menuitem", { name: /Delete instance|删除实例/ })).not.toBeInTheDocument();
  });

  it("keeps the menu open while the page scrolls", async () => {
    render(<MoreActionsMenu task={task} {...defaultProps} />);

    fireEvent.click(screen.getByRole("button"));
    expect(await screen.findByRole("menu")).toBeInTheDocument();

    fireEvent.scroll(window);
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("notifies the parent when the menu opens and closes", async () => {
    const onOpenChange = vi.fn();
    render(<MoreActionsMenu task={task} {...defaultProps} onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByRole("button"));
    await screen.findByRole("menu");
    expect(onOpenChange).toHaveBeenCalledWith("1", true, expect.objectContaining({ left: expect.any(Number), top: expect.any(Number) }), expect.any(HTMLElement));

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(onOpenChange).toHaveBeenCalledWith("1", false);
  });

  it("leaves out every customized bar action and drops a section left empty", async () => {
    render(
      <MoreActionsMenu
        task={task}
        {...defaultProps}
        stripActions={["download", "template", "pin", "raw"]}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringMatching(/Logs|日志/),
      expect.stringMatching(/Terminal|终端/),
      expect.stringMatching(/Clone|克隆/),
      expect.stringMatching(/Commit image|提交镜像/),
    ]);
    // Connect and lifecycle remain; the local section had nothing left, so no second divider.
    expect(screen.getAllByRole("separator")).toHaveLength(1);
  });

  it("offers monitor in More whenever it is not on the row", async () => {
    const onMonitor = vi.fn();
    const { unmount } = render(<MoreActionsMenu task={task} {...defaultProps} onMonitor={onMonitor} />);

    fireEvent.click(screen.getByRole("button"));
    expect(await screen.findByRole("menuitem", { name: /Monitor|监控/ })).toBeInTheDocument();
    unmount();

    render(<MoreActionsMenu task={task} {...defaultProps} stripActions={["monitor"]} onMonitor={onMonitor} />);
    fireEvent.click(screen.getByRole("button"));
    await screen.findAllByRole("menuitem");
    expect(screen.queryByRole("menuitem", { name: /Monitor|监控/ })).not.toBeInTheDocument();
  });
});
