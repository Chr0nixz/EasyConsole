import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18N_STORAGE_KEY, I18nProvider } from "../lib/i18n";
import { DEFAULT_NOTIFICATION_PREFERENCES, setRuntimeSettings } from "../lib/app-settings";
import { browserRuntime } from "../lib/runtime";
import { taskSnapshotQueryKey } from "../lib/task-snapshot-query";
import type { MonitorIndexResponse, Task } from "../lib/types";
import { ToastProvider } from "./Toast";

const mocks = vi.hoisted(() => ({
  items: [] as Task[],
  monitorIndex: vi.fn(),
}));

vi.mock("../lib/fetch-all-tasks", () => ({
  fetchAllTasks: () =>
    Promise.resolve({
      items: mocks.items,
      total: mocks.items.length,
      raw: null,
      pagesFetched: 1,
      timedOut: false,
    }),
}));

vi.mock("../lib/api", () => ({
  instanceApi: {
    monitorIndex: (...args: unknown[]) => mocks.monitorIndex(...args),
  },
}));

vi.mock("../lib/use-auth", () => ({
  useAuth: () => ({
    token: "Bearer test",
    user: { username: "alice" },
    ready: true,
    restoringSession: false,
    savedAccounts: [],
  }),
}));

import { IdleInstanceWatcher } from "./IdleInstanceWatcher";

/** Seven samples every 10 minutes: a full hour of quiet CPU. */
function quietMetrics(): MonitorIndexResponse {
  const now = Date.now();
  const data = Array.from({ length: 7 }, (_, index) => ({
    timestamp: now - (6 - index) * 10 * 60_000,
    value: 1,
  }));
  return { cpu: [{ name: "cpu", data }], network: [{ name: "net", data: data.map((point) => ({ ...point, value: 0 })) }] };
}

function busyMetrics(): MonitorIndexResponse {
  const now = Date.now();
  const data = Array.from({ length: 7 }, (_, index) => ({
    timestamp: now - (6 - index) * 10 * 60_000,
    value: 80,
  }));
  return { cpu: [{ name: "cpu", data }] };
}

function runningTask(): Task {
  return { id: 1, task_id: "task-1", name: "train", status: 2 } as Task;
}

function renderWatcher(client: QueryClient) {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <ToastProvider>
          <QueryClientProvider client={client}>
            <IdleInstanceWatcher />
          </QueryClientProvider>
        </ToastProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

/** Publishes a fresh snapshot so the watcher effect re-runs past its throttle. */
async function publishSnapshot(client: QueryClient, items: Task[], advanceMs: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(advanceMs);
  });
  mocks.items = items;
  await act(async () => {
    client.setQueryData(taskSnapshotQueryKey(), { items, total: items.length, raw: null, pagesFetched: 1, timedOut: false });
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("IdleInstanceWatcher", () => {
  let client: QueryClient;
  let notifySystem: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.localStorage.clear();
    window.localStorage.setItem(I18N_STORAGE_KEY, "zh-CN");
    setRuntimeSettings({});
    mocks.items = [];
    mocks.monitorIndex.mockReset();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    notifySystem = vi.spyOn(browserRuntime, "notifySystem").mockResolvedValue("shown");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("warns once for an idle running instance and stays quiet afterwards", async () => {
    mocks.items = [runningTask()];
    mocks.monitorIndex.mockResolvedValue(quietMetrics());
    renderWatcher(client);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.monitorIndex).toHaveBeenCalledTimes(1);
    expect(notifySystem).toHaveBeenCalledTimes(1);
    expect(notifySystem).toHaveBeenCalledWith(expect.objectContaining({ title: "实例可能闲置" }));

    // Still idle on later checks (past the 60s throttle): the same episode
    // must not re-warn.
    await publishSnapshot(client, [runningTask()], 121_000);
    expect(mocks.monitorIndex.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(notifySystem).toHaveBeenCalledTimes(1);
  });

  it("re-arms after the instance becomes active again", async () => {
    mocks.items = [runningTask()];
    // The 121s advance can trigger several checks per round, so the metrics
    // follow a switchable current value rather than a call-ordinal chain.
    let current: MonitorIndexResponse = quietMetrics();
    mocks.monitorIndex.mockImplementation(() => Promise.resolve(current));
    renderWatcher(client);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(notifySystem).toHaveBeenCalledTimes(1);

    current = busyMetrics();
    await publishSnapshot(client, [runningTask()], 121_000);
    expect(notifySystem).toHaveBeenCalledTimes(1);

    current = quietMetrics();
    await publishSnapshot(client, [runningTask()], 121_000);
    expect(notifySystem).toHaveBeenCalledTimes(2);
  });

  it("does not poll metrics when the idle preference is off", async () => {
    mocks.items = [runningTask()];
    setRuntimeSettings({
      notificationPreferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, "task.idle": "off" },
    });
    renderWatcher(client);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await publishSnapshot(client, [runningTask()], 0);
    expect(mocks.monitorIndex).not.toHaveBeenCalled();
    expect(notifySystem).not.toHaveBeenCalled();
  });

  it("ignores tasks that are not running", async () => {
    mocks.items = [{ ...runningTask(), status: 4 } as Task];
    renderWatcher(client);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await publishSnapshot(client, mocks.items, 121_000);
    expect(mocks.monitorIndex).not.toHaveBeenCalled();
  });
});
