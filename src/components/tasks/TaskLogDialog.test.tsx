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

  it("debounces filter and announces match count", async () => {
    renderDialog();

    await screen.findByText(/alpha line/);

    const search = screen.getByRole("textbox", { name: /查找日志|Search logs/ });
    fireEvent.change(search, { target: { value: "beta" } });

    expect(screen.queryByText(/行匹配|matching lines/)).not.toBeInTheDocument();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });

    await waitFor(() => {
      expect(screen.getByText(/1 行匹配|1 matching lines/)).toBeInTheDocument();
    });
    expect(screen.getByText("beta line")).toBeInTheDocument();
    expect(screen.queryByText("alpha line")).not.toBeInTheDocument();
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
