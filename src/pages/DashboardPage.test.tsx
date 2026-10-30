import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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
  const view = render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <DashboardPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { ...view, client };
}

describe("DashboardPage", () => {
  beforeEach(() => {
    mocks.consoleQuery.mockReset();
    mocks.statics.mockReset();
    mocks.consoleQuery.mockResolvedValue({ run_task_count: 1, pending_task_count: 2, run_time: { week: 60 }, cost_map: { month: 3 } });
    mocks.statics.mockResolvedValue({ items: [{ id: 1, name: "demo", status: 2, cpu: 4, gpu: 1, memory: 16 }] });
  });

  it("shows dashboard summary and recent tasks without raw responses", async () => {
    renderDashboard();

    await waitFor(() => expect(screen.getAllByText("demo").length).toBeGreaterThanOrEqual(1));

    const detailLinks = screen.getAllByRole("link", { name: /查看实例 demo 详情|View details for demo/ });
    expect(detailLinks.length).toBeGreaterThanOrEqual(1);
    expect(detailLinks[0]).toHaveAttribute("href", "/tasks/1");
    expect(screen.getByRole("link", { name: /^运行中$|^Running$/ })).toHaveAttribute("href", "/tasks?status=2");
    expect(screen.getByRole("link", { name: /查看失败|View failed/ })).toHaveAttribute("href", "/tasks?status=7");
    expect(screen.getByRole("link", { name: /查看异常|View exceptions/ })).toHaveAttribute("href", "/tasks?status=8");
    expect(screen.queryByText("/instance/console")).not.toBeInTheDocument();
    expect(screen.queryByText("/instance/statics")).not.toBeInTheDocument();
    expect(screen.queryByText(/run_task_count/)).not.toBeInTheDocument();
  });

  it("shows statics errors instead of an empty state", async () => {
    mocks.statics.mockRejectedValue(new Error("statics failed"));
    renderDashboard();

    await waitFor(() => expect(screen.getByText("statics failed")).toBeInTheDocument());
    expect(screen.queryByText("暂无最近实例")).not.toBeInTheDocument();
    expect(screen.queryByText("没有失败或异常实例")).not.toBeInTheDocument();
    expect(screen.queryByText("没有运行中的实例")).not.toBeInTheDocument();
    expect(screen.queryByText("没有队列中的实例")).not.toBeInTheDocument();

    mocks.statics.mockResolvedValue({ items: [] });
    fireEvent.click(screen.getByRole("button", { name: /重试|Retry/ }));
    expect(await screen.findByText("没有失败或异常实例")).toBeInTheDocument();
  });

  it("keeps task health unknown while the task request is pending", async () => {
    mocks.statics.mockReturnValue(new Promise(() => {}));
    renderDashboard();

    expect(await screen.findByRole("status", { name: "正在读取实例状态" })).toBeInTheDocument();
    expect(screen.queryByText("没有失败或异常实例")).not.toBeInTheDocument();
    expect(screen.queryByText("没有运行中的实例")).not.toBeInTheDocument();
    expect(screen.queryByText("没有队列中的实例")).not.toBeInTheDocument();
  });

  it("marks cached instance status as stale after a failed refresh", async () => {
    const { client } = renderDashboard();
    await waitFor(() => expect(screen.getAllByText("demo").length).toBeGreaterThan(0));
    mocks.statics.mockRejectedValue(new Error("refresh failed"));

    await act(async () => { await client.refetchQueries({ queryKey: ["statics"] }); });

    expect(await screen.findByText(/实例状态刷新失败，以下为上次成功读取的数据/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /查看实例 demo 详情/ })).toBeInTheDocument();
  });

  it("states the hourly billing rate of running instances", async () => {
    mocks.statics.mockResolvedValue({ items: [
      { id: 1, name: "a", status: 2, price: 12 },
      { id: 2, name: "b", status: 2, price: 6.5 },
      { id: 3, name: "c", status: 6, price: 99 },
    ] });
    renderDashboard();

    expect(await screen.findByText("约 18.50 元/小时")).toBeInTheDocument();
  });

  it("reads the billing rate as a floor when a running instance has no price", async () => {
    mocks.statics.mockResolvedValue({ items: [
      { id: 1, name: "a", status: 2, price: 12 },
      { id: 2, name: "b", status: 2 },
    ] });
    renderDashboard();

    expect(await screen.findByText("至少 12.00 元/小时")).toBeInTheDocument();
  });

  it("shows empty recent-task actions", async () => {
    mocks.statics.mockResolvedValue({ items: [] });
    renderDashboard();

    expect(await screen.findByText(/暂无最近实例|No recent instances/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /去任务实例|Go to tasks/ })).toHaveAttribute("href", "/tasks");
    expect(screen.getByRole("link", { name: /新建实例|New instance/ })).toHaveAttribute("href", "/tasks");
  });
});
