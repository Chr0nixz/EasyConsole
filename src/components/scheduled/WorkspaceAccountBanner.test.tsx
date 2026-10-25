import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetAccountScope, setActiveAccountScope } from "../../lib/account-scope";
import { I18nProvider } from "../../lib/i18n";
import type { CreateTaskPayload, ScheduledTask } from "../../lib/types";
import { WorkspaceAccountBanner } from "./WorkspaceAccountBanner";

function makeTask(overrides: Partial<ScheduledTask> & { id: string; name: string }): ScheduledTask {
  return {
    scheduleTime: "2026-10-25T09:00",
    status: "pending",
    payload: { name: overrides.name, price: 1, cpu: 4, memory: 16, img: 1 } as CreateTaskPayload,
    createdAt: "2026-10-20T09:00:00.000Z",
    updatedAt: "2026-10-20T09:00:00.000Z",
    ...overrides,
  };
}

function renderBanner(tasks: ScheduledTask[], onFocusTask: (id: string) => void = vi.fn()) {
  render(
    <I18nProvider>
      <WorkspaceAccountBanner tasks={tasks} onFocusTask={onFocusTask} />
    </I18nProvider>,
  );
  return onFocusTask;
}

describe("WorkspaceAccountBanner", () => {
  beforeEach(() => {
    resetAccountScope();
  });

  it("counts schedules owned by other accounts or legacy records and lists their owners", () => {
    setActiveAccountScope({ key: "alice@116.172.93.164:28080", displayName: "Alice" });
    renderBanner([
      makeTask({ id: "task-1", name: "mine", owner: { key: "alice@116.172.93.164:28080", displayName: "Alice" } }),
      makeTask({ id: "task-2", name: "theirs", owner: { key: "bob@116.172.93.164:28080", displayName: "Bob" } }),
      makeTask({ id: "task-3", name: "old-data" }),
    ]);

    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText(/2 scheduled task|2 个定时任务/)).toBeInTheDocument();
    expect(screen.getByText("theirs")).toBeInTheDocument();
    expect(screen.getByText(/Bob/)).toBeInTheDocument();
    expect(screen.getByText("old-data")).toBeInTheDocument();
    expect(screen.getByText(/Unknown origin|来源未知/)).toBeInTheDocument();
    expect(screen.queryByText("mine")).not.toBeInTheDocument();
  });

  it("shows no ownership warning when every schedule belongs to the current account", () => {
    setActiveAccountScope({ key: "alice@116.172.93.164:28080", displayName: "Alice" });
    renderBanner([
      makeTask({ id: "task-1", name: "mine", owner: { key: "alice@116.172.93.164:28080", displayName: "Alice" } }),
      makeTask({ id: "task-2", name: "also-mine", owner: { key: "alice@116.172.93.164:28080", displayName: "Alice" } }),
    ]);

    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.queryByText(/已暂停自动执行|automatic execution is paused/)).not.toBeInTheDocument();
    expect(screen.queryByText(/来源未知|Unknown origin/)).not.toBeInTheDocument();
  });

  it("ignores finished schedules when counting unverifiable owners", () => {
    setActiveAccountScope({ key: "alice@116.172.93.164:28080", displayName: "Alice" });
    renderBanner([
      makeTask({ id: "task-1", name: "finished", status: "done", owner: { key: "bob@116.172.93.164:28080", displayName: "Bob" } }),
    ]);

    expect(screen.queryByText(/已暂停自动执行|automatic execution is paused/)).not.toBeInTheDocument();
  });

  it("explains the anonymous workspace where ownership cannot be verified", () => {
    renderBanner([
      makeTask({ id: "task-1", name: "mine", owner: { key: "alice@116.172.93.164:28080", displayName: "Alice" } }),
    ]);

    expect(screen.getAllByText(/未登录|Not signed in/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/归属无法确认|cannot be verified/)).toBeInTheDocument();
    expect(screen.getByText("mine")).toBeInTheDocument();
  });

  it("jumps to the referenced task row on click", () => {
    setActiveAccountScope({ key: "alice@116.172.93.164:28080", displayName: "Alice" });
    const onFocusTask = vi.fn();
    renderBanner(
      [makeTask({ id: "task-2", name: "theirs", owner: { key: "bob@116.172.93.164:28080", displayName: "Bob" } })],
      onFocusTask,
    );

    fireEvent.click(screen.getByRole("button", { name: "theirs" }));
    expect(onFocusTask).toHaveBeenCalledWith("task-2");
  });
});
