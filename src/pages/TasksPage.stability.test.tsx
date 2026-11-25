import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { browserRuntime } from "../lib/runtime";
import { I18nProvider } from "../lib/i18n";
import { ApiError, type Task } from "../lib/types";
import { instanceApi } from "../lib/api";
import { TasksPage } from "./TasksPage";

const tasks: Task[] = [
  { id: 1, name: "running-job", status: 2, gpu: 1, cpu: 8, memory: 64, use_time: 600 } as Task,
  { id: 2, name: "failed-job", status: 7, gpu: 2, cpu: 16, memory: 128, use_time: 300 } as Task,
];

vi.mock("../lib/api", () => ({
  apiClient: { getToken: () => null, getBaseUrl: () => "http://local/api" },
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

function renderPage(entry = "/tasks") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[entry]}>
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

  it("keeps resize handles out of the Tab order and says how to move between rows", async () => {
    renderPage();

    const handles = await screen.findAllByRole("separator", { name: /列宽|Resize .* column/i });
    expect(handles.length).toBeGreaterThan(0);
    for (const handle of handles) expect(handle).toHaveAttribute("tabindex", "-1");

    const region = screen.getByRole("region", { name: /任务实例表格|Task instances table/ });
    expect(region).toHaveAccessibleDescription(/j \/ k/);
  });

  it("exposes the active sort on the column it applies to", async () => {
    renderPage("/tasks?sortBy=cost&sortDir=asc");

    const cost = await screen.findByRole("columnheader", { name: /费用|Cost/ });
    expect(cost).toHaveAttribute("aria-sort", "ascending");
    expect(screen.getByRole("columnheader", { name: /状态|Status/ })).not.toHaveAttribute("aria-sort");
  });

  it("sets a column width from the column settings without the drag handle", async () => {
    window.localStorage.removeItem("easy-console.tasks.columnSizing");
    renderPage();
    await screen.findByRole("separator", { name: /调整实例名称列宽|Resize Instance name column/i });

    fireEvent.click(screen.getByRole("button", { name: /^(视图|View)$/ }));
    fireEvent.click(screen.getByRole("button", { name: /^(列设置|Columns)$/ }));

    const width = await screen.findByRole("spinbutton", { name: /实例名称列宽|Instance name column width/ });
    expect(width).toHaveValue(240);
    fireEvent.change(width, { target: { value: "9999" } });
    fireEvent.blur(width);

    // Clamped to the column's range, exactly as a drag would be.
    expect(width).toHaveValue(560);
    expect(screen.getByRole("separator", { name: /调整实例名称列宽|Resize Instance name column/i, hidden: true })).toHaveAttribute("aria-valuenow", "560");
  });

  it("resizes a table column by drag or keyboard and saves its width", async () => {
    window.localStorage.removeItem("easy-console.tasks.columnSizing");
    const storageSet = vi.spyOn(browserRuntime.storage, "set");
    renderPage();

    const resizeHandle = await screen.findByRole("separator", { name: /调整实例名称列宽|Resize Instance name column/i });
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "240");
    const selectionHandle = screen.getByRole("separator", { name: /调整选择列宽|Resize Selection column/i });
    const actionsHandle = screen.getByRole("separator", { name: /调整操作列宽|Resize Actions column/i });
    expect(selectionHandle).toHaveAttribute("aria-valuenow", "48");
    expect(actionsHandle).toHaveAttribute("aria-valuenow", "232");

    fireEvent.keyDown(selectionHandle, { key: "ArrowRight" });
    fireEvent.keyDown(actionsHandle, { key: "ArrowRight" });

    expect(selectionHandle).toHaveAttribute("aria-valuenow", "64");
    expect(actionsHandle).toHaveAttribute("aria-valuenow", "248");
    fireEvent.doubleClick(actionsHandle);
    expect(actionsHandle).toHaveAttribute("aria-valuenow", "232");

    fireEvent.keyDown(resizeHandle, { key: "ArrowRight" });

    expect(resizeHandle).toHaveAttribute("aria-valuenow", "256");

    fireEvent.mouseDown(resizeHandle, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 150 });
    fireEvent.mouseUp(document, { clientX: 150 });

    expect(resizeHandle).toHaveAttribute("aria-valuenow", "306");
    await waitFor(() => {
      expect(storageSet).toHaveBeenCalledWith(
        "easy-console.tasks.columnSizing",
        expect.stringContaining('"name":306'),
      );
    });
    storageSet.mockRestore();
  });

  it("moves a release column still at the old default to the new width, and keeps a chosen one", async () => {
    window.localStorage.setItem("easy-console.tasks.columnSizing", JSON.stringify({ releaseCondition: 140, name: 300 }));
    const { unmount } = renderPage();
    const releaseHandle = () => screen.findByRole("separator", { name: /调整释放条件列宽|Resize Release condition column/i });
    await waitFor(async () => expect(await releaseHandle()).toHaveAttribute("aria-valuenow", "200"));
    expect(screen.getByRole("separator", { name: /调整实例名称列宽|Resize Instance name column/i })).toHaveAttribute("aria-valuenow", "300");
    unmount();

    window.localStorage.setItem("easy-console.tasks.columnSizing", JSON.stringify({ releaseCondition: 160 }));
    renderPage();
    await waitFor(async () => expect(await releaseHandle()).toHaveAttribute("aria-valuenow", "160"));
    window.localStorage.removeItem("easy-console.tasks.columnSizing");
  });

  it("customizes the row action bar from its header, resizes its column, and remembers the choice", async () => {
    window.localStorage.removeItem("easy-console.tasks.columnSizing");
    window.localStorage.removeItem("easy-console.tasks.quickActions");
    const storageSet = vi.spyOn(browserRuntime.storage, "set");
    renderPage();

    await screen.findByRole("button", { name: /克隆实例 running-job|Clone instance running-job/ });
    const actionsHandle = () => screen.getByRole("separator", { name: /调整操作列宽|Resize Actions column/i, hidden: true });
    expect(actionsHandle()).toHaveAttribute("aria-valuenow", "232");

    fireEvent.click(screen.getByRole("button", { name: /^(自定义操作栏|Customize action bar)$/ }));
    const dialog = await screen.findByRole("dialog", { name: /自定义操作栏|Customize action bar/ });
    fireEvent.click(within(dialog).getByRole("button", { name: /添加 原始 JSON 到操作栏|Add Raw JSON to the bar/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: /从操作栏移除 克隆实例|Remove Clone instance from the bar/ }));

    // The row trades clone for raw JSON; the bar keeps three buttons, so the column keeps its width.
    expect(screen.getByRole("button", { name: /查看 running-job 的原始 JSON|View raw JSON for running-job/, hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /克隆实例 running-job|Clone instance running-job/, hidden: true })).not.toBeInTheDocument();
    expect(actionsHandle()).toHaveAttribute("aria-valuenow", "232");

    // A fourth button widens the column by its 36px slot, so the bar does not fold into More.
    fireEvent.click(within(dialog).getByRole("button", { name: /添加 监控 到操作栏|Add Monitor to the bar/ }));
    expect(actionsHandle()).toHaveAttribute("aria-valuenow", "268");
    expect(screen.getByRole("button", { name: /打开 running-job 的监控|Open monitor for running-job/, hidden: true })).toBeInTheDocument();

    await waitFor(() => {
      expect(storageSet).toHaveBeenCalledWith("easy-console.tasks.quickActions", JSON.stringify(["terminal", "log", "raw", "monitor"]));
    });
    storageSet.mockRestore();
    window.localStorage.removeItem("easy-console.tasks.quickActions");
  });

  it("restores a saved action bar and sizes a column saved without a width to fit it", async () => {
    window.localStorage.setItem("easy-console.tasks.quickActions", JSON.stringify(["commit", "terminal", "log", "clone", "raw"]));
    window.localStorage.removeItem("easy-console.tasks.columnSizing");
    renderPage();

    const commit = await screen.findByRole("button", { name: /提交 running-job 的镜像|Commit an image of running-job/ });
    // A stopped task keeps commit in its slot, disabled with the reason, so the bar never shifts.
    const failedCommit = screen.getByRole("button", { name: /提交 failed-job 的镜像|Commit an image of failed-job/ });
    expect(failedCommit).toHaveAttribute("aria-disabled", "true");
    expect(failedCommit).toHaveAccessibleDescription(/仅运行中实例可提交镜像|Only running instances can be committed/);
    expect(commit).not.toHaveAttribute("aria-disabled");
    await waitFor(() => {
      expect(screen.getByRole("separator", { name: /调整操作列宽|Resize Actions column/i })).toHaveAttribute("aria-valuenow", "304");
    });
    window.localStorage.removeItem("easy-console.tasks.quickActions");
  });
});

describe("TasksPage batch release outcomes", () => {
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 800 });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 1200 });
  });

  afterEach(() => {
    vi.mocked(instanceApi.operateTask).mockReset();
    if (originalOffsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
    if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidth);
  });

  it("brings the result dialog back when a backgrounded release ends with an unknown item", async () => {
    let rejectRelease: (error: unknown) => void = () => {};
    vi.mocked(instanceApi.operateTask).mockImplementation(
      () => new Promise((_resolve, reject) => {
        rejectRelease = reject;
      }),
    );
    renderPage();

    fireEvent.click(await screen.findByRole("checkbox", { name: /选择实例 running-job|Select instance running-job/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^(释放 1 个|Release 1)$/ }));
    const preview = within(await screen.findByRole("dialog", { name: /确认批量释放|Confirm Batch Release/ }));
    fireEvent.click(preview.getByRole("button", { name: /释放 1 个实例|Release 1 instances/ }));
    const progress = within(await screen.findByRole("dialog", { name: /批量释放结果|Batch release results/ }));
    fireEvent.click(progress.getByRole("button", { name: /后台运行|Run in background/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /批量释放结果|Batch release results/ })).not.toBeInTheDocument());

    // The release request times out: the instance may still be running and billing.
    await act(async () => {
      rejectRelease(new ApiError("socket hang up", { kind: "network" }));
    });

    const result = within(await screen.findByRole("dialog", { name: /批量释放结果|Batch release results/ }));
    expect(result.getByTestId("batch-result-summary")).toHaveTextContent(/未知 1|1 unknown/);
    expect(result.getByText(/在列表里核对实际状态|actual state in the list/)).toBeInTheDocument();
  });
});
