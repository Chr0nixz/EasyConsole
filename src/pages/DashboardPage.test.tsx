import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  statics: vi.fn(),
  consoleQuery: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  instanceApi: {
    console: () => mocks.consoleQuery(),
    statics: () => mocks.statics(),
  },
}));

import { DashboardPage } from "./DashboardPage";

function renderDashboard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DashboardPage />
    </QueryClientProvider>,
  );
}

describe("DashboardPage", () => {
  beforeEach(() => {
    mocks.consoleQuery.mockReset();
    mocks.statics.mockReset();
    mocks.consoleQuery.mockResolvedValue({ run_task_count: 1, pending_task_count: 2, run_time: { week: 60 }, cost_map: { month: 3 } });
    mocks.statics.mockResolvedValue({ items: [{ id: 1, name: "demo", status: 2, cpu: 4, gpu: 1, memory: 16 }] });
  });

  it("shows raw responses in a collapsible panel", async () => {
    renderDashboard();

    await waitFor(() => expect(screen.getByText("demo")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /原始响应/ }));

    expect(screen.getByText("/instance/console")).toBeInTheDocument();
    expect(screen.getByText("/instance/statics")).toBeInTheDocument();
    expect(screen.getByText(/run_task_count/)).toBeInTheDocument();
  });

  it("shows statics errors instead of an empty state", async () => {
    mocks.statics.mockRejectedValue(new Error("statics failed"));
    renderDashboard();

    await waitFor(() => expect(screen.getByText("statics failed")).toBeInTheDocument());
    expect(screen.queryByText("暂无最近任务")).not.toBeInTheDocument();
  });
});
