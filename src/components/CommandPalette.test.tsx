import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "./Toast";
import { I18nProvider } from "../lib/i18n";
import { RunLoggerContext } from "../lib/use-run-logger";

const mocks = vi.hoisted(() => ({
  tasks: vi.fn(),
  operateTask: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  instanceApi: {
    tasks: (...args: unknown[]) => mocks.tasks(...args),
    operateTask: (...args: unknown[]) => mocks.operateTask(...args),
  },
}));

import { CommandPalette } from "./CommandPalette";

function renderCommandPalette(initialEntries = ["/"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: <CommandPalette open onClose={vi.fn()} />,
      },
    ],
    { initialEntries },
  );
  return {
    router,
    ...render(
      <I18nProvider>
        <ToastProvider>
          <RunLoggerContext.Provider value={{ log: async () => undefined }}>
            <QueryClientProvider client={client}>
              <RouterProvider router={router} />
            </QueryClientProvider>
          </RunLoggerContext.Provider>
        </ToastProvider>
      </I18nProvider>,
    ),
  };
}

describe("CommandPalette", () => {
  beforeEach(() => {
    mocks.tasks.mockReset();
    mocks.operateTask.mockReset();
    mocks.tasks.mockResolvedValue({ items: [] });
  });

  it("exposes active command results with combobox and listbox semantics", async () => {
    renderCommandPalette();

    const input = screen.getByRole("combobox");
    const listbox = screen.getByRole("listbox", { name: /命令结果|Command results/ });
    const options = screen.getAllByRole("option");

    expect(input).toHaveAttribute("aria-controls", listbox.id);
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-activedescendant", options[0].id);
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "ArrowDown" });

    await waitFor(() => expect(input).toHaveAttribute("aria-activedescendant", options[1].id));
    expect(options[1]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "End" });

    const finalOptions = screen.getAllByRole("option");
    await waitFor(() => expect(input).toHaveAttribute("aria-activedescendant", finalOptions.at(-1)?.id));
    expect(finalOptions.at(-1)).toHaveAttribute("aria-selected", "true");
  });

  it("expands matched tasks into detail, log, and terminal actions", async () => {
    mocks.tasks.mockResolvedValue({
      items: [{ id: 42, name: "demo-task", status: 2 }],
    });
    const { router } = renderCommandPalette();

    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "demo" } });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 320));
    });

    await screen.findByText(/demo-task · 日志|demo-task · Logs/);
    expect(screen.getByText(/demo-task · 终端|demo-task · Terminal/)).toBeInTheDocument();
    expect(screen.getByText(/demo-task · 释放|demo-task · Release/)).toBeInTheDocument();

    fireEvent.click(screen.getByText(/demo-task · 日志|demo-task · Logs/));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/tasks/42");
      expect(router.state.location.search).toBe("?tab=log");
    });
  });
});
