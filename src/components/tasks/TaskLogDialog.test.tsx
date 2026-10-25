import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../Toast";
import { I18nProvider } from "../../lib/i18n";
import type { Task } from "../../lib/types";
import { TaskLogDialog } from "./TaskLogDialog";

vi.mock("../../lib/api", () => ({
  instanceApi: {
    taskLog: vi.fn(),
  },
}));

import { instanceApi } from "../../lib/api";

const task = { id: 7, task_id: 7, name: "demo-task" } as Task;

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <I18nProvider>
      <ToastProvider>
        <QueryClientProvider client={client}>
          <TaskLogDialog task={task} onClose={vi.fn()} />
        </QueryClientProvider>
      </ToastProvider>
    </I18nProvider>,
  );
}

describe("TaskLogDialog", () => {
  beforeEach(() => {
    vi.mocked(instanceApi.taskLog).mockResolvedValue("alpha line\nbeta line\ngamma line");
  });

  it("debounces find, announces the match position, and keeps surrounding lines visible", async () => {
    renderDialog();

    await screen.findByText(/alpha line/);

    const search = screen.getByRole("textbox", { name: /查找日志|Search logs/ });
    fireEvent.change(search, { target: { value: "beta" } });

    expect(screen.queryByText(/第 1 \/ 1 处|1 of 1/)).not.toBeInTheDocument();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });

    await waitFor(() => {
      expect(screen.getByText(/第 1 \/ 1 处|1 of 1/)).toBeInTheDocument();
    });
    expect(screen.getByText("beta line")).toBeInTheDocument();
    // Context stays: find highlights, it does not filter, until "matching lines only" is on.
    expect(screen.getByText("alpha line")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /只显示匹配行|Show matching lines only/ }));
    expect(screen.queryByText("alpha line")).not.toBeInTheDocument();
    expect(screen.getByText("beta line")).toBeInTheDocument();
  });

  it("summarizes a failed task's log with the exception line and exit code", async () => {
    vi.mocked(instanceApi.taskLog).mockResolvedValue(
      "step 1 loss=2.1\nTraceback (most recent call last):\n  File \"train.py\", line 9\ntorch.OutOfMemoryError: CUDA out of memory\n[launcher] process exited with code 1",
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <I18nProvider>
        <ToastProvider>
          <QueryClientProvider client={client}>
            <TaskLogDialog task={{ ...task, status: 7 }} onClose={vi.fn()} />
          </QueryClientProvider>
        </ToastProvider>
      </I18nProvider>,
    );

    expect(await screen.findByText(/失败原因|Failure/)).toBeInTheDocument();
    expect(screen.getByTitle("torch.OutOfMemoryError: CUDA out of memory")).toBeInTheDocument();
    expect(screen.getByText(/退出码 1|exit code 1/)).toBeInTheDocument();
  });

  it("truncates oversized logs for display while keeping the tail", async () => {
    const fullLog = `${"head-marker-"}${"x".repeat(500_100)}\ntail-marker`;
    vi.mocked(instanceApi.taskLog).mockResolvedValue(fullLog);

    renderDialog();

    await screen.findByText(/tail-marker/);
    expect(screen.getByText(/日志已截断展示|Log display truncated/)).toBeInTheDocument();
    expect(screen.queryByText(/head-marker-/)).not.toBeInTheDocument();
  });
});
