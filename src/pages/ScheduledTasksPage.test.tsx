import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../components/Toast";
import { makeAccountScope, resetAccountScope, setActiveAccountScope } from "../lib/account-scope";
import { setRuntimeSettings } from "../lib/app-settings";
import { EXECUTION_LEDGER_STORAGE_KEY } from "../lib/execution-ledger";
import { I18N_STORAGE_KEY, I18nProvider } from "../lib/i18n";
import { createScheduledTask, SCHEDULED_TASKS_STORAGE_KEY } from "../lib/scheduled-tasks";
import { ApiError, type ScheduledTask } from "../lib/types";
import { RunLoggerContext } from "../lib/use-run-logger";

const mocks = vi.hoisted(() => ({ createTask: vi.fn(), log: vi.fn() }));

vi.mock("../lib/api", () => ({
  imageApi: {
    list: async () => ({ items: [{ id: 1, name: "test-image" }] }),
    system: async () => ({ items: [] }),
  },
  resourceApi: { resources: async () => [], prices: async () => [] },
  instanceApi: { createTask: mocks.createTask, checkTaskName: async () => false },
}));

vi.mock("../lib/use-auth", () => ({ useAuth: () => ({ user: { username: "tester" } }) }));

import { ScheduledTasksPage } from "./ScheduledTasksPage";

let client: QueryClient;

function seedTask(overrides: Partial<ScheduledTask> = {}) {
  const task = {
    ...createScheduledTask({
      name: "nightly-train",
      scheduleTime: new Date(Date.now() - 60_000).toISOString(),
      payload: { name: "train", img: 1, price: 1, cpu: 4, memory: 16, releace_conditions: 1 },
    }),
    ...overrides,
  };
  window.localStorage.setItem(SCHEDULED_TASKS_STORAGE_KEY, JSON.stringify([task]));
  return task;
}

function storedTasks(): ScheduledTask[] {
  return JSON.parse(window.localStorage.getItem(SCHEDULED_TASKS_STORAGE_KEY) ?? "[]") as ScheduledTask[];
}

function renderPage() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter>
      <I18nProvider>
        <QueryClientProvider client={client}>
          <RunLoggerContext.Provider value={{ log: mocks.log }}>
            <ToastProvider><ScheduledTasksPage /></ToastProvider>
          </RunLoggerContext.Provider>
        </QueryClientProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

async function taskRow(name = "nightly-train") {
  const region = await screen.findByRole("region", { name: /定时任务表格|Scheduled tasks table/ });
  return within(within(region).getByText(name).closest("tr")!);
}

async function openRunPreview() {
  fireEvent.click((await taskRow()).getByRole("button", { name: /^(执行|Run)$/ }));
  return within(await screen.findByRole("dialog", { name: /确认立即执行|Run Now/ }));
}

describe("ScheduledTasksPage execution safety", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(I18N_STORAGE_KEY, "en-US");
    setRuntimeSettings({});
    setActiveAccountScope(makeAccountScope("tester", "Tester", "http://console.example/api"));
    mocks.createTask.mockReset().mockResolvedValue({ id: "remote-42" });
    mocks.log.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    client?.clear();
    resetAccountScope();
    setRuntimeSettings({});
    vi.restoreAllMocks();
  });

  it("loads due plans without creating instances, and cancellation leaves the plan pending", async () => {
    seedTask();
    renderPage();
    const preview = await openRunPreview();
    expect(preview.getByText("tester")).toBeInTheDocument();
    expect(mocks.createTask).not.toHaveBeenCalled();
    fireEvent.click(preview.getByRole("button", { name: /取消|Cancel/ }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(storedTasks()[0].status).toBe("pending");
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("creates only after impact confirmation and records the remote result in the plan and ledger", async () => {
    const task = seedTask();
    renderPage();
    const preview = await openRunPreview();
    fireEvent.click(preview.getByRole("button", { name: /创建 1 个实例|Create 1 instance/ }));
    await waitFor(() => expect(storedTasks()[0]).toMatchObject({ status: "done", lastRemoteTaskId: "remote-42" }));
    expect(mocks.createTask).toHaveBeenCalledExactlyOnceWith(task.payload);
    const ledger: unknown = JSON.parse(window.localStorage.getItem(EXECUTION_LEDGER_STORAGE_KEY) ?? "[]");
    expect(ledger).toEqual(expect.arrayContaining([expect.objectContaining({ trigger: "manual", outcome: "completed", remoteTaskId: "remote-42" })]));
  });

  it("holds a foreign-account plan for review even after manual run confirmation", async () => {
    seedTask({ owner: makeAccountScope("other", "Other", "http://console.example/api") });
    renderPage();
    const preview = await openRunPreview();
    fireEvent.click(preview.getByRole("button", { name: /创建 1 个实例|Create 1 instance/ }));
    await waitFor(() => expect(storedTasks()[0].status).toBe("needs_review"));
    expect(mocks.createTask).not.toHaveBeenCalled();
    expect(storedTasks()[0].owner?.displayName).toBe("Other");
  });

  it("keeps a timed-out create unknown instead of making it runnable by Run due", async () => {
    seedTask();
    mocks.createTask.mockRejectedValue(new ApiError("response lost", { kind: "network" }));
    renderPage();
    const preview = await openRunPreview();
    fireEvent.click(preview.getByRole("button", { name: /创建 1 个实例|Create 1 instance/ }));
    await waitFor(() => expect(storedTasks()[0].status).toBe("needs_review"));
    expect(mocks.createTask).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: /执行到期|Run due/ })).toBeDisabled());
    const ledger: unknown = JSON.parse(window.localStorage.getItem(EXECUTION_LEDGER_STORAGE_KEY) ?? "[]");
    expect(ledger).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: "unknown" })]));
  });

  it("refreshes the list before Run due and creates nothing for a slot that already ran", async () => {
    const task = seedTask({ recurrence: { type: "daily" } });
    renderPage();
    await taskRow();
    // The background runner ran this slot and moved the plan to tomorrow after the page loaded.
    const tomorrow = new Date(Date.parse(task.scheduleTime) + 24 * 60 * 60 * 1000).toISOString();
    window.localStorage.setItem(SCHEDULED_TASKS_STORAGE_KEY, JSON.stringify([{ ...task, scheduleTime: tomorrow, lastRemoteTaskId: "remote-earlier" }]));

    fireEvent.click(screen.getByRole("button", { name: /执行到期|Run due/ }));

    expect(await screen.findByText(/没有到期的计划|No plans are due/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /确认执行到期计划|Run Due Plans/ })).not.toBeInTheDocument();
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("creates nothing when a due slot runs elsewhere while the Run due preview is open", async () => {
    const task = seedTask({ recurrence: { type: "daily" } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /执行到期|Run due/ }));
    const preview = within(await screen.findByRole("dialog", { name: /确认执行到期计划|Run Due Plans/ }));
    const tomorrow = new Date(Date.parse(task.scheduleTime) + 24 * 60 * 60 * 1000).toISOString();
    window.localStorage.setItem(SCHEDULED_TASKS_STORAGE_KEY, JSON.stringify([{ ...task, scheduleTime: tomorrow, lastRemoteTaskId: "remote-earlier" }]));

    fireEvent.click(preview.getByRole("button", { name: /创建 1 个实例|Create 1 instance/ }));

    expect(await screen.findByText(/计划已不再到期|Plan is no longer due/)).toBeInTheDocument();
    expect(mocks.createTask).not.toHaveBeenCalled();
    expect(storedTasks()[0]).toMatchObject({ status: "pending", scheduleTime: tomorrow, lastRemoteTaskId: "remote-earlier" });
  });

  it("previews a timed release as 24 hours after submission", async () => {
    // The slot is a week out; a run now must not inherit the slot's release moment.
    const day = 24 * 60 * 60 * 1000;
    seedTask({
      scheduleTime: new Date(Date.now() + 7 * day).toISOString(),
      payload: { name: "train", img: 1, price: 1, cpu: 4, memory: 16, releace_conditions: 2 },
    });
    renderPage();

    const preview = await openRunPreview();

    expect(preview.getByText(/释放时间|Releases at/)).toBeInTheDocument();
    const release = preview.getByText(/提交后 24 小时|24 hours after submission/);
    const localDate = (ms: number) => {
      const date = new Date(ms);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    };
    expect(release).toHaveTextContent(localDate(Date.now() + day));
    expect(release).not.toHaveTextContent(localDate(Date.now() + 8 * day));
  });

  it("rechecks ownership if the account changes while the impact preview is open", async () => {
    seedTask();
    renderPage();
    const preview = await openRunPreview();
    setActiveAccountScope(makeAccountScope("other", "Other", "http://console.example/api"));
    fireEvent.click(preview.getByRole("button", { name: /创建 1 个实例|Create 1 instance/ }));
    await waitFor(() => expect(storedTasks()[0].status).toBe("needs_review"));
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("does not replace a completed run with a stale Pause action", async () => {
    const task = seedTask();
    renderPage();
    const row = await taskRow();
    window.localStorage.setItem(SCHEDULED_TASKS_STORAGE_KEY, JSON.stringify([{ ...task, status: "done", lastRemoteTaskId: "concurrent-42" }]));
    fireEvent.click(row.getByRole("button", { name: /^(暂停|Pause)$/ }));
    await waitFor(async () => expect((await taskRow()).queryByRole("button", { name: /^(暂停|Pause)$/ })).not.toBeInTheDocument());
    expect(storedTasks()[0]).toMatchObject({ status: "done", lastRemoteTaskId: "concurrent-42" });
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("does not clear a concurrent execution lease with a stale Resume action", async () => {
    const task = seedTask({ status: "paused" });
    renderPage();
    const row = await taskRow();
    const running = { ...task, status: "running", executionKey: "active-run", leaseStartedAt: new Date().toISOString() };
    window.localStorage.setItem(SCHEDULED_TASKS_STORAGE_KEY, JSON.stringify([running]));
    fireEvent.click(row.getByRole("button", { name: /^(恢复|Resume)$/ }));
    await waitFor(async () => expect((await taskRow()).queryByRole("button", { name: /^(恢复|Resume)$/ })).not.toBeInTheDocument());
    expect(storedTasks()[0]).toEqual(JSON.parse(JSON.stringify(running)));
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("resumes a reviewed recurring plan at its next occurrence after explaining it", async () => {
    const slot = new Date(Date.now() - 5 * 60_000).toISOString();
    seedTask({ status: "needs_review", scheduleTime: slot, recurrence: { type: "daily" }, lastError: "Remote create outcome unknown" });
    renderPage();

    fireEvent.click((await taskRow()).getByRole("button", { name: /^(恢复|Resume)$/ }));
    const dialog = within(await screen.findByRole("dialog", { name: /恢复待确认的计划|Resume Plan Under Review/ }));
    expect(dialog.getByText(/不会重放这一次|does not replay this run/)).toBeInTheDocument();
    expect(storedTasks()[0].status).toBe("needs_review");

    fireEvent.click(dialog.getByRole("button", { name: /^(恢复|Resume)$/ }));

    await waitFor(() => expect(storedTasks()[0].status).toBe("pending"));
    expect(Date.parse(storedTasks()[0].scheduleTime)).toBeGreaterThan(Date.now());
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("keeps unsaved input and the current execution when another window runs a plan being edited", async () => {
    const task = seedTask({ scheduleTime: new Date(Date.now() + 3_600_000).toISOString() });
    renderPage();
    fireEvent.click((await taskRow()).getByRole("button", { name: /^(编辑|Edit)$/ }));
    fireEvent.change(screen.getByRole("textbox", { name: /备注|Notes/ }), { target: { value: "my edit" } });
    const running = { ...task, status: "running", executionKey: "active-run", leaseStartedAt: new Date().toISOString() };
    window.localStorage.setItem(SCHEDULED_TASKS_STORAGE_KEY, JSON.stringify([running]));
    fireEvent.click(screen.getByRole("button", { name: /保存修改|Save changes/ }));
    expect(await screen.findByText(/计划已在其他窗口更新|The plan changed in another window/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /备注|Notes/ })).toHaveValue("my edit");
    expect(storedTasks()[0]).toEqual(JSON.parse(JSON.stringify(running)));
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("preserves the instant of an offset timestamp when opening it in the local-time editor", async () => {
    const task = seedTask({ scheduleTime: "2035-01-02T12:34:00+09:00" });
    renderPage();
    fireEvent.click((await taskRow()).getByRole("button", { name: /^(编辑|Edit)$/ }));
    const input = await screen.findByLabelText(/计划执行时间|Scheduled time/) as HTMLInputElement;
    expect(new Date(input.value).getTime()).toBe(Date.parse(task.scheduleTime));
  });

  it("does not overwrite a concurrent completion when confirming a stale missed-run skip", async () => {
    const task = seedTask({ scheduleTime: new Date(Date.now() - 3_600_000).toISOString() });
    renderPage();
    fireEvent.click((await taskRow()).getByRole("button", { name: /跳过本次|Skip this run/ }));
    const dialog = within(await screen.findByRole("dialog"));
    window.localStorage.setItem(SCHEDULED_TASKS_STORAGE_KEY, JSON.stringify([{ ...task, status: "done", lastRemoteTaskId: "concurrent-42" }]));
    fireEvent.click(dialog.getByRole("button", { name: /^(跳过|Skip)$/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(storedTasks()[0]).toMatchObject({ status: "done", lastRemoteTaskId: "concurrent-42" });
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("saves a future plan with the signed-in owner without submitting it remotely", async () => {
    renderPage();
    fireEvent.click((await screen.findAllByRole("button", { name: /新建计划|New plan/ }))[0]);
    fireEvent.change(screen.getByRole("textbox", { name: /实例名称|Instance name/ }), { target: { value: "future-train" } });
    await waitFor(() => expect(screen.getByRole("combobox", { name: /镜像|Image/ })).toHaveValue("1"));
    // An empty price list prefills no rate; the plan cannot be saved until one is entered.
    const rate = screen.getByRole("spinbutton", { name: /计费单价|Hourly rate/ });
    expect(rate).toHaveValue(null);
    fireEvent.change(rate, { target: { value: "1" } });
    expect(fireEvent.submit(screen.getByRole("textbox", { name: /实例名称|Instance name/ }).closest("form")!)).toBe(false);
    await waitFor(() => expect(storedTasks()).toHaveLength(1));
    expect(storedTasks()[0]).toMatchObject({ name: "future-train", status: "pending", owner: { displayName: "Tester" }, payload: { name: "future-train", img: 1 } });
    expect(mocks.createTask).not.toHaveBeenCalled();
  });
});
