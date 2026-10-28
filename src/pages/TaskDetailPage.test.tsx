import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../components/Toast";
import { RunLoggerProvider } from "../components/RunLoggerProvider";
import { I18nProvider } from "../lib/i18n";

const mocks = vi.hoisted(() => ({
  tasks: vi.fn(),
  taskLog: vi.fn(),
  updateTask: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  instanceApi: {
    tasks: (...args: unknown[]) => mocks.tasks(...args),
    taskLog: (...args: unknown[]) => mocks.taskLog(...args),
    monitorIndex: vi.fn(),
    updateTask: (...args: unknown[]) => mocks.updateTask(...args),
  },
}));

vi.mock("../lib/use-auth", () => ({
  useAuth: () => ({
    token: "Bearer test",
    user: { username: "alice" },
    ready: true,
    restoringSession: false,
    savedAccounts: [],
    login: vi.fn(),
    loginSaved: vi.fn(),
    forgetSavedAccount: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
  }),
}));

import { TaskDetailPage } from "./TaskDetailPage";

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      {
        path: "/tasks/:id",
        element: (
          <I18nProvider>
            <RunLoggerProvider>
              <ToastProvider>
                <QueryClientProvider client={client}>
                  <TaskDetailPage />
                </QueryClientProvider>
              </ToastProvider>
            </RunLoggerProvider>
          </I18nProvider>
        ),
      },
    ],
    { initialEntries: ["/tasks/42"] },
  );
  return render(<RouterProvider router={router} />);
}

describe("TaskDetailPage", () => {
  beforeEach(() => {
    mocks.tasks.mockReset();
    mocks.taskLog.mockReset();
    mocks.updateTask.mockReset().mockResolvedValue({});
    mocks.tasks.mockResolvedValue({
      items: [
        {
          id: 42,
          name: "train-job",
          status: 2,
          releace_conditions: 1,
          cpu: 8,
          gpu: 1,
          memory: 32,
          storage_path: "/alice/train",
          ip: "10.0.0.8",
          node_name: "gpu-node-1",
        },
      ],
      total: 1,
    });
    mocks.taskLog.mockResolvedValue("ready log line");
  });

  it("shows a summary with backend release condition and inline logs instead of an empty trampoline", async () => {
    renderDetail();

    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "train-job" })).toBeInTheDocument());
    expect(screen.getByText(/手动释放|Manual release/)).toBeInTheDocument();
    expect(screen.getByText("/alice/train")).toBeInTheDocument();
    expect(screen.getByText("gpu-node-1")).toBeInTheDocument();
    expect(screen.queryByText(/点击下方按钮查看日志|Click the button below to view logs/)).not.toBeInTheDocument();
    expect(await screen.findByText("ready log line")).toBeInTheDocument();
  });

  it("extends a timed release through editing and refreshes the task", async () => {
    const releaseAt = new Date(Date.now() + 5 * 60_000).toISOString();
    mocks.tasks.mockResolvedValue({ items: [{ id: 42, name: "timed", status: 2, releace_conditions: 2, releace_time: releaseAt }], total: 1 });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: /延长释放|Extend release/ }));
    const dialog = screen.getByRole("dialog", { name: /延长定时释放|Extend timed release/ });
    fireEvent.click(within(dialog).getByRole("button", { name: /确认延长|^Extend$/ }));
    await waitFor(() => expect(mocks.updateTask).toHaveBeenCalledTimes(1));
    const [id, payload] = mocks.updateTask.mock.calls[0] as [number, { releace_time: string }];
    expect(id).toBe(42);
    expect(Date.parse(payload.releace_time)).toBeGreaterThanOrEqual(Date.parse(releaseAt) + 3_600_000 - 1000);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /延长定时释放|Extend timed release/ })).not.toBeInTheDocument());
    expect(mocks.tasks.mock.calls.length).toBeGreaterThan(1);
  });

  it("keeps the extension dialog open and explains unsupported editing", async () => {
    mocks.tasks.mockResolvedValue({ items: [{ id: 42, name: "timed", status: 2, releace_conditions: 2, releace_time: new Date(Date.now() + 5 * 60_000).toISOString() }], total: 1 });
    mocks.updateTask.mockRejectedValue(new Error("Safe editing unsupported"));
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: /延长释放|Extend release/ }));
    const dialog = screen.getByRole("dialog", { name: /延长定时释放|Extend timed release/ });
    fireEvent.click(within(dialog).getByRole("button", { name: /确认延长|^Extend$/ }));
    expect(await screen.findByText(/Safe editing unsupported/)).toBeInTheDocument();
    expect(dialog).toBeInTheDocument();
  });
});
