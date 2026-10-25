import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../lib/i18n";
import type { Task } from "../lib/types";
import { TasksPage } from "./TasksPage";

const tasks: Task[] = [
  { id: 1, name: "running-job", status: 2, gpu: 1, cpu: 8, memory: 64, use_time: 600 } as Task,
  { id: 2, name: "failed-job", status: 7, gpu: 2, cpu: 16, memory: 128, use_time: 300 } as Task,
];

vi.mock("../lib/api", () => ({
  instanceApi: {
    tasks: vi.fn(async () => ({ items: tasks, total: tasks.length })),
    operateTask: vi.fn(),
    deleteTask: vi.fn(),
    downloadTask: vi.fn(),
    checkTaskName: vi.fn(),
  },
}));

vi.mock("../lib/use-auth", () => ({ useAuth: () => ({ user: { username: "tester" } }) }));
vi.mock("../lib/use-toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), notify: vi.fn() }) }));
vi.mock("../lib/use-run-logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/use-run-logger")>()),
  useRunLogger: () => ({ log: vi.fn() }),
}));
vi.mock("../lib/use-download-queue", () => ({ useDownloadQueueActions: () => ({ enqueue: vi.fn() }) }));
vi.mock("../lib/commit-queue-context", () => ({ useCommitQueue: () => ({ enqueue: vi.fn(), summary: { completed: 0 } }) }));
vi.mock("../lib/use-ssh-workspace", () => ({ useSshWorkspace: () => ({ tabs: [], openTarget: vi.fn() }) }));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/tasks"]}>
          <TasksPage />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("TasksPage row stability", () => {
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // jsdom lays nothing out; the row virtualizer needs a sized scroll element to render rows.
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 800 });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 1200 });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalOffsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
    if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidth);
  });

  it("keeps a focused row control mounted and focused across the 5 s clock tick", async () => {
    renderPage();

    const logButton = await screen.findByRole("button", { name: /打开 running-job 的日志|Open logs for running-job/ });
    act(() => logButton.focus());
    expect(logButton).toHaveFocus();

    // The page re-renders on its relative-time tick; row controls must not be remounted by it.
    await act(async () => {
      vi.advanceTimersByTime(5_100);
    });

    expect(logButton.isConnected).toBe(true);
    expect(logButton).toHaveFocus();
  });
});
