import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { ToastProvider } from "../components/Toast";
import { RUN_LOGS_STORAGE_KEY } from "../lib/run-logs";
import { RunLogsPage } from "./RunLogsPage";

describe("RunLogsPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("shows stored run logs without instance log content", async () => {
    window.localStorage.setItem(
      RUN_LOGS_STORAGE_KEY,
      JSON.stringify([
        {
          id: "log-1",
          createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
          level: "info",
          channel: "web",
          source: "task",
          action: "task.create",
          result: "success",
          title: "实例创建已提交",
          targetName: "demo",
        },
      ]),
    );

    render(
      <ToastProvider>
        <RunLogsPage />
      </ToastProvider>,
    );

    await waitFor(() => expect(screen.getAllByText("实例创建已提交").length).toBeGreaterThanOrEqual(1));
    expect(screen.getAllByText("demo").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("/instance/task_log")).not.toBeInTheDocument();
  });
});
