import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../components/Toast";
import { I18nProvider } from "../lib/i18n";

const mocks = vi.hoisted(() => ({
  tasks: vi.fn(),
  taskLog: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  instanceApi: {
    tasks: (...args: unknown[]) => mocks.tasks(...args),
    taskLog: (...args: unknown[]) => mocks.taskLog(...args),
    monitorIndex: vi.fn(),
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
            <ToastProvider>
              <QueryClientProvider client={client}>
                <TaskDetailPage />
              </QueryClientProvider>
            </ToastProvider>
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
});
