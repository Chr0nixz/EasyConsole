import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../components/Toast";
import { RunLoggerContext } from "../lib/use-run-logger";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock("../lib/remote-storage", async () => {
  const actual = await vi.importActual<typeof import("../lib/remote-storage")>("../lib/remote-storage");
  return {
    ...actual,
    remoteStorage: {
      ...actual.remoteStorage,
      list: (...args: unknown[]) => mocks.list(...args),
    },
  };
});

vi.mock("../lib/download-queue-context", () => ({
  useDownloadQueue: () => ({
    items: [],
    summary: { total: 0, active: 0, completed: 0, failed: 0, cancelled: 0, percent: 0 },
    enqueue: mocks.enqueue,
    cancel: vi.fn(),
    retry: vi.fn(),
    clearCompleted: vi.fn(),
  }),
}));

vi.mock("../lib/use-confirm-action", () => ({
  useConfirmAction: () => ({
    confirm: vi.fn(),
    confirmDialog: null,
  }),
}));

import { StoragePage } from "./StoragePage";

function renderStorage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <RunLoggerContext.Provider value={{ log: async () => undefined }}>
      <ToastProvider>
        <QueryClientProvider client={client}>
          <StoragePage />
        </QueryClientProvider>
      </ToastProvider>
    </RunLoggerContext.Provider>,
  );
}

describe("StoragePage", () => {
  beforeEach(() => {
    mocks.list.mockReset();
    mocks.enqueue.mockReset();
    mocks.list.mockResolvedValue({
      items: [
        { name: "notes.txt", path: "/notes.txt", is_dir: false, size: 12 },
        { name: "datasets", path: "/datasets", is_dir: true },
      ],
    });
  });

  it("lists remote storage entries", async () => {
    renderStorage();

    await waitFor(() => expect(screen.getByText("notes.txt")).toBeInTheDocument());
    expect(screen.getByText("datasets")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新建|New/ })).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledWith({ path: "/" });
  });

  it("shows list errors instead of an empty directory", async () => {
    mocks.list.mockRejectedValue(new Error("storage offline"));
    renderStorage();

    await waitFor(() => expect(screen.getByText("storage offline")).toBeInTheDocument());
    expect(screen.queryByText(/当前目录为空|Current directory is empty/)).not.toBeInTheDocument();
  });
});
