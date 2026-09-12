import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18N_STORAGE_KEY, I18nProvider, useI18n } from "../lib/i18n";
import { browserRuntime } from "../lib/runtime";
import { TASK_SNAPSHOT_QUERY_KEY } from "../lib/task-snapshot-query";
import type { Task } from "../lib/types";
import { ToastProvider } from "./Toast";

const mocks = vi.hoisted(() => ({ items: [] as Task[] }));

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

vi.mock("../lib/use-auth", () => ({
  useAuth: () => ({
    token: "Bearer test",
    user: { username: "alice" },
    ready: true,
    restoringSession: false,
    savedAccounts: [],
  }),
}));

import { TaskNotificationWatcher } from "./TaskNotificationWatcher";

function LocaleProbe() {
  const { locale, setLocale } = useI18n();
  return (
    <>
      <span data-testid="locale">{locale}</span>
      <button type="button" onClick={() => setLocale(locale === "en-US" ? "zh-CN" : "en-US")}>
        switch-locale
      </button>
    </>
  );
}

function renderWatcher(client: QueryClient) {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <ToastProvider>
          <QueryClientProvider client={client}>
            <TaskNotificationWatcher />
            <LocaleProbe />
          </QueryClientProvider>
        </ToastProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

function task(status: number): Task {
  return { id: 1, task_id: "task-1", name: "train", status } as Task;
}

describe("TaskNotificationWatcher", () => {
  let client: QueryClient;
  let notifySystem: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(I18N_STORAGE_KEY, "zh-CN");
    mocks.items = [task(2)];
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    notifySystem = vi.spyOn(browserRuntime, "notifySystem").mockResolvedValue("shown");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("notifies once per status change and never on a language switch", async () => {
    renderWatcher(client);

    // Wait for the initial snapshot to settle: it must not notify.
    await waitFor(() => expect(screen.getByTestId("locale")).toHaveTextContent("zh-CN"));
    await waitFor(() => expect(client.getQueryData(TASK_SNAPSHOT_QUERY_KEY)).toBeTruthy());
    expect(notifySystem).not.toHaveBeenCalled();

    // Switching language re-runs the watcher effect; it must not re-notify.
    fireEvent.click(screen.getByRole("button", { name: "switch-locale" }));
    await waitFor(() => expect(screen.getByTestId("locale")).toHaveTextContent("en-US"));
    expect(notifySystem).not.toHaveBeenCalled();

    // A real status change notifies once, in the active language.
    mocks.items = [task(6)];
    client.setQueryData(TASK_SNAPSHOT_QUERY_KEY, { items: mocks.items, total: 1, raw: null });
    await waitFor(() => expect(notifySystem).toHaveBeenCalledTimes(1));
    expect(notifySystem).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Instance succeeded", body: "train: Succeeded" }),
    );

    // Switching back must not replay the notification.
    fireEvent.click(screen.getByRole("button", { name: "switch-locale" }));
    await waitFor(() => expect(screen.getByTestId("locale")).toHaveTextContent("zh-CN"));
    expect(notifySystem).toHaveBeenCalledTimes(1);
  });
});
