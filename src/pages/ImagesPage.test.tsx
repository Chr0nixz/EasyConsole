import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../components/Toast";
import { RunLoggerContext } from "../lib/use-run-logger";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  system: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  imageApi: {
    list: (...args: unknown[]) => mocks.list(...args),
    system: (...args: unknown[]) => mocks.system(...args),
    setDefault: vi.fn(),
    download: vi.fn(),
  },
}));

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

vi.mock("../lib/image-favorites", () => ({
  loadFavoriteImages: async () => [],
  toggleFavoriteImage: async () => [],
}));

import { ImagesPage } from "./ImagesPage";

function renderImages() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <RunLoggerContext.Provider value={{ log: async () => undefined }}>
      <ToastProvider>
        <QueryClientProvider client={client}>
          <ImagesPage />
        </QueryClientProvider>
      </ToastProvider>
    </RunLoggerContext.Provider>,
  );
}

describe("ImagesPage", () => {
  beforeEach(() => {
    mocks.list.mockReset();
    mocks.system.mockReset();
    mocks.enqueue.mockReset();
    mocks.list.mockResolvedValue({ items: [{ id: 11, name: "custom-cuda", tag: "latest" }] });
    mocks.system.mockResolvedValue({ items: [{ id: 21, name: "system-base", tag: "v1" }] });
  });

  it("merges custom and system images into the table", async () => {
    renderImages();

    await waitFor(() => expect(screen.getAllByText(/custom-cuda/).length).toBeGreaterThanOrEqual(1));
    expect(screen.getAllByText(/system-base/).length).toBeGreaterThanOrEqual(1);
    expect(mocks.list).toHaveBeenCalled();
    expect(mocks.system).toHaveBeenCalled();
  });

  it("shows custom image errors with a retry action", async () => {
    mocks.list.mockRejectedValue(new Error("custom images failed"));
    renderImages();

    await waitFor(() => expect(screen.getByText("custom images failed")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /重试自定义镜像|Retry custom images/ })).toBeInTheDocument();
  });
});
