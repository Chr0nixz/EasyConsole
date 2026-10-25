import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeAccountScope, resetAccountScope, setActiveAccountScope } from "../lib/account-scope";
import { setRuntimeSettings } from "../lib/app-settings";
import { I18N_STORAGE_KEY, I18nProvider } from "../lib/i18n";
import { RUN_LOGS_STORAGE_KEY, parseRunLogs } from "../lib/run-logs";
import { SCHEDULED_TASKS_STORAGE_KEY } from "../lib/scheduled-tasks";
import type { CreateTaskPayload, ScheduledTask } from "../lib/types";
import { ToastProvider } from "./Toast";

const mocks = vi.hoisted(() => ({
  createTask: vi.fn(),
  checkTaskName: vi.fn(),
}));

// The runner only touches instanceApi.createTask / checkTaskName; keeping the
// mock minimal lets the real executeScheduledTask claim/lease/complete path run.
vi.mock("../lib/api", () => ({
  instanceApi: {
    createTask: mocks.createTask,
    checkTaskName: mocks.checkTaskName,
  },
}));

import { BackgroundScheduledTaskRunner } from "./BackgroundScheduledTaskRunner";

const MINUTE = 60_000;

function payload(): CreateTaskPayload {
  return {
    name: "train",
    price: 1,
    cpu: 4,
    memory: 16,
    img: 1,
    storage_path: "/tester",
    mount_path: "/home/ubuntu/tester",
    releace_conditions: 1,
  };
}

function seedTask(offsetMs: number): ScheduledTask {
  const scope = makeAccountScope("tester", "Tester", "http://console.example/api");
  const task: ScheduledTask = {
    id: "sched-1",
    name: "train",
    scheduleTime: new Date(Date.now() + offsetMs).toISOString(),
    status: "pending",
    payload: payload(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    owner: scope,
  };
  window.localStorage.setItem(SCHEDULED_TASKS_STORAGE_KEY, JSON.stringify([task]));
  return task;
}

function storedTasks(): ScheduledTask[] {
  return JSON.parse(window.localStorage.getItem(SCHEDULED_TASKS_STORAGE_KEY) ?? "[]") as ScheduledTask[];
}

function runLogActions(): string[] {
  return parseRunLogs(window.localStorage.getItem(RUN_LOGS_STORAGE_KEY)).map((entry) => entry.action);
}

function renderRunner() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <I18nProvider>
        <ToastProvider>
          <QueryClientProvider client={client}>
            <BackgroundScheduledTaskRunner />
          </QueryClientProvider>
        </ToastProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

/** Flush the mount-time pass (and any pending microtasks) without ticking the interval. */
async function flushInitialPass() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** Run the background loop for one or more 30-second ticks. */
async function tick(times = 1) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
  }
}

describe("BackgroundScheduledTaskRunner missed-run policy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    window.localStorage.setItem(I18N_STORAGE_KEY, "zh-CN");
    // The provider's first render derives the locale from navigator.language
    // (en in jsdom) before the stored key applies; the runner persists
    // i18nText notes during that window. Pin the language so the persisted
    // notes are deterministically Chinese.
    Object.defineProperty(window.navigator, "language", { configurable: true, get: () => "zh-CN" });
    // setRuntimeSettings is module state; reset to defaults before each test so
    // a policy set by one test cannot leak into the next.
    setRuntimeSettings({});
    setActiveAccountScope(makeAccountScope("tester", "Tester", "http://console.example/api"));
    mocks.createTask.mockReset().mockResolvedValue({ id: "remote-1" });
    // Bare boolean false = name is free (see isTaskNameAvailableResponse).
    mocks.checkTaskName.mockReset().mockResolvedValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAccountScope();
    delete (window.navigator as unknown as Record<string, unknown>).language;
  });

  it("executes a due task that is still inside the grace window", async () => {
    setRuntimeSettings({});
    seedTask(-1 * MINUTE);

    renderRunner();
    await flushInitialPass();

    expect(mocks.createTask).toHaveBeenCalledTimes(1);
    expect(storedTasks()[0]).toMatchObject({ status: "done", lastRemoteTaskId: "remote-1" });
  });

  it("catches up a missed run when the policy is run", async () => {
    setRuntimeSettings({ missedSchedulePolicy: "run" });
    seedTask(-30 * MINUTE);

    renderRunner();
    await flushInitialPass();

    expect(mocks.createTask).toHaveBeenCalledTimes(1);
    expect(storedTasks()[0]).toMatchObject({ status: "done", lastRemoteTaskId: "remote-1" });
  });

  it("skips a missed one-shot run instead of executing it when the policy is skip", async () => {
    setRuntimeSettings({ missedSchedulePolicy: "skip" });
    seedTask(-30 * MINUTE);

    renderRunner();
    await flushInitialPass();
    await tick(1);

    expect(mocks.createTask).not.toHaveBeenCalled();
    expect(storedTasks()[0]).toMatchObject({ status: "done" });
    expect(storedTasks()[0]?.lastError).toContain("跳过");
    expect(runLogActions()).toContain("scheduledTask.missedSkip");
  });

  it("keeps a missed run pending under the default ask policy and asks only once", async () => {
    const seeded = seedTask(-30 * MINUTE);

    renderRunner();
    await flushInitialPass();
    await tick(2);

    expect(mocks.createTask).not.toHaveBeenCalled();
    const stored = storedTasks()[0];
    expect(stored).toMatchObject({ status: "pending" });
    expect(stored?.scheduleTime).toBe(seeded.scheduleTime);
    expect(runLogActions().filter((action) => action === "scheduledTask.missedAsk")).toHaveLength(1);
  });

  it("does not treat a future schedule as missed", async () => {
    setRuntimeSettings({});
    seedTask(5 * MINUTE);

    renderRunner();
    await flushInitialPass();
    await tick(1);

    expect(mocks.createTask).not.toHaveBeenCalled();
    expect(runLogActions()).not.toContain("scheduledTask.missedAsk");
    expect(storedTasks()[0]).toMatchObject({ status: "pending" });
  });
});
