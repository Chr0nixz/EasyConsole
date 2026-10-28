import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APP_SETTINGS, setRuntimeSettings } from "../lib/app-settings";
import { makeAccountScope, resetAccountScope, setActiveAccountScope } from "../lib/account-scope";
import { I18nProvider } from "../lib/i18n";
import { browserRuntime } from "../lib/runtime";
import { taskSnapshotQueryKey } from "../lib/task-snapshot-query";
import { ToastContext } from "../lib/use-toast";

const mocks = vi.hoisted(() => ({
  token: "Bearer local", now: 0, monitor: vi.fn(), release: vi.fn(), notify: vi.fn(), success: vi.fn(), error: vi.fn(),
  task: { id: 42, task_id: "pod42", name: "local", status: 2, gpu: 2, create_time: "2026-10-27" },
}));
vi.mock("../lib/api", () => ({
  apiClient: { getToken: () => mocks.token, getBaseUrl: () => "http://local/api" },
  instanceApi: { monitorIndex: (...args: unknown[]) => mocks.monitor(...args), operateTask: (...args: unknown[]) => mocks.release(...args) },
}));
vi.mock("../lib/fetch-all-tasks", () => ({ fetchAllTasks: async () => ({ items: [mocks.task], total: 1, raw: null }) }));
vi.mock("../lib/use-auth", () => ({ useAuth: () => ({ token: mocks.token, user: { username: "alice" } }) }));
import { IdleInstanceWatcher } from "./IdleInstanceWatcher";

const toast = { notify: mocks.notify, success: mocks.success, error: mocks.error, info: vi.fn() };
let client: QueryClient;
function renderWatcher() {
  return render(<MemoryRouter><I18nProvider><ToastContext.Provider value={toast}><QueryClientProvider client={client}><IdleInstanceWatcher /></QueryClientProvider></ToastContext.Provider></I18nProvider></MemoryRouter>);
}
async function tick() {
  mocks.now += 60_001;
  await act(async () => {
    client.setQueryData(taskSnapshotQueryKey(), { items: [{ ...mocks.task }], total: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("idle watcher acceptance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.now = Date.parse("2026-10-27T00:00:00Z");
    mocks.token = "Bearer local";
    mocks.task.status = 2;
    vi.spyOn(Date, "now").mockImplementation(() => mocks.now);
    vi.spyOn(browserRuntime, "isDesktop", "get").mockReturnValue(true);
    vi.spyOn(browserRuntime, "readTaskGpuUtilization").mockResolvedValue([0, 0]);
    mocks.release.mockResolvedValue({});
    mocks.monitor.mockImplementation(async () => {
      const data = Array.from({ length: 121 }, (_, index) => ({ timestamp: mocks.now - index * 60_000, value: 0 }));
      return { cpu: [{ data }], network: [{ data }] };
    });
    setActiveAccountScope(makeAccountScope("alice", "alice", "http://local/api"));
    setRuntimeSettings({ ...DEFAULT_APP_SETTINGS, idleReminderWindowMs: 30 * 60_000, idleAutoRelease: true, notificationPreferences: { ...DEFAULT_APP_SETTINGS.notificationPreferences, "task.idle": "app" } });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => { cleanup(); client.clear(); vi.restoreAllMocks(); localStorage.clear(); resetAccountScope(); setRuntimeSettings(DEFAULT_APP_SETTINGS); });

  it("never releases with missing GPU data, and a busy device suppresses idle reminders", async () => {
    vi.mocked(browserRuntime.readTaskGpuUtilization).mockResolvedValueOnce([0, 80]).mockResolvedValue(null);
    renderWatcher();
    await waitFor(() => expect(mocks.monitor).toHaveBeenCalledTimes(1));
    expect(mocks.notify).not.toHaveBeenCalled();
    await tick();
    await waitFor(() => expect(mocks.notify).toHaveBeenCalledTimes(1));
    mocks.now += 31 * 60_000;
    await tick();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("starts watching immediately after saving an enabled preference", async () => {
    setRuntimeSettings({ ...DEFAULT_APP_SETTINGS, notificationPreferences: { ...DEFAULT_APP_SETTINGS.notificationPreferences, "task.idle": "off" } });
    renderWatcher();
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    expect(mocks.monitor).not.toHaveBeenCalled();
    act(() => setRuntimeSettings({ ...DEFAULT_APP_SETTINGS, idleAutoRelease: true }));
    await waitFor(() => expect(mocks.monitor).toHaveBeenCalledTimes(1));
  });

  it("requires the full sampling window, releases once, and persists the attempt", async () => {
    renderWatcher();
    await waitFor(() => expect(mocks.notify).toHaveBeenCalledTimes(1));
    expect(mocks.release).not.toHaveBeenCalled();
    for (let minute = 1; minute < 30; minute++) await tick();
    expect(mocks.release).not.toHaveBeenCalled();
    await tick();
    await waitFor(() => expect(mocks.release).toHaveBeenCalledExactlyOnceWith(42));
    await tick();
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.success).toHaveBeenCalled();
  });

  it("does not notify or release when the account changes during a metrics request", async () => {
    let resolve!: (data: unknown) => void;
    mocks.monitor.mockImplementation(() => new Promise((done) => { resolve = done; }));
    renderWatcher();
    await waitFor(() => expect(mocks.monitor).toHaveBeenCalledTimes(1));
    mocks.token = "Bearer switched";
    setActiveAccountScope(makeAccountScope("bob", "bob", "http://local/api"));
    await act(async () => { resolve({ cpu: [], network: [] }); await new Promise((done) => setTimeout(done, 0)); });
    expect(browserRuntime.readTaskGpuUtilization).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("warns once per idle episode and re-arms after CPU activity", async () => {
    const quiet = mocks.monitor.getMockImplementation()!;
    let busy = false;
    mocks.monitor.mockImplementation(async () => busy
      ? { cpu: [{ data: [{ timestamp: mocks.now, value: 80 }] }] }
      : quiet());
    renderWatcher();
    await waitFor(() => expect(mocks.notify).toHaveBeenCalledTimes(1));
    await tick();
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    busy = true;
    await tick();
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    busy = false;
    await tick();
    await waitFor(() => expect(mocks.notify).toHaveBeenCalledTimes(2));
  });

  it("ignores tasks that are not running", async () => {
    mocks.task.status = 4;
    renderWatcher();
    await tick();
    expect(mocks.monitor).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("falls back to an app notification if system delivery fails", async () => {
    setRuntimeSettings({ ...DEFAULT_APP_SETTINGS, idleReminderWindowMs: 30 * 60_000 });
    const notify = vi.spyOn(browserRuntime, "notifySystem").mockRejectedValue(new Error("notification service offline"));
    renderWatcher();
    await waitFor(() => expect(mocks.notify).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledTimes(1);
    await tick();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(mocks.release).not.toHaveBeenCalled();
  });
});
