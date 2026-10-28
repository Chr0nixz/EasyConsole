import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../components/Toast";
import { RunLoggerContext } from "../lib/use-run-logger";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  system: vi.fn(),
  enqueue: vi.fn(),
  update: vi.fn(), remove: vi.fn(), confirm: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  imageApi: {
    list: (...args: unknown[]) => mocks.list(...args),
    system: (...args: unknown[]) => mocks.system(...args),
    setDefault: vi.fn(),
    download: vi.fn(),
    updateImage: (...args: unknown[]) => mocks.update(...args),
    deleteImage: (...args: unknown[]) => mocks.remove(...args),
  },
}));

vi.mock("../lib/use-download-queue", () => ({
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
    confirm: mocks.confirm,
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
    mocks.update.mockReset().mockResolvedValue({});
    mocks.remove.mockReset().mockResolvedValue({});
    mocks.confirm.mockReset();
    mocks.list.mockResolvedValue({ items: [{ id: 11, name: "custom-cuda", tag: "latest" }] });
    mocks.system.mockResolvedValue({ items: [{ id: 21, name: "system-base", tag: "v1" }] });
  });

  it("merges custom and system images into the table", async () => {
    renderImages();

    await waitFor(() => expect(screen.getAllByText(/custom-cuda/).length).toBeGreaterThanOrEqual(1));
    expect(screen.getAllByText(/system-base/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/自定义 1 · 系统 1 · 默认 0|Custom 1 · system 1 · default 0/)).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalled();
    expect(mocks.system).toHaveBeenCalled();
  });

  it("shows custom image errors with a retry action", async () => {
    mocks.list.mockRejectedValue(new Error("custom images failed"));
    renderImages();

    await waitFor(() => expect(screen.getByText("custom images failed")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /重试自定义镜像|Retry custom images/ })).toBeInTheDocument();
  });

  it("edits only custom images, trims fields, and refreshes after saving", async () => {
    renderImages();
    fireEvent.click((await screen.findAllByRole("button", { name: /编辑镜像 custom-cuda|Edit image custom-cuda/ }))[0]);
    const dialog = screen.getByRole("dialog", { name: /编辑镜像|Edit image/ });
    fireEvent.change(within(dialog).getByLabelText(/名称|Name/), { target: { value: "  renamed  " } });
    fireEvent.change(within(dialog).getByLabelText(/说明|Description/), { target: { value: "  details  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: /保存|Save/ }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledExactlyOnceWith(11, { name: "renamed", description: "details" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /编辑镜像|Edit image/ })).not.toBeInTheDocument());
    expect(mocks.list.mock.calls.length).toBeGreaterThan(1);
    expect(screen.queryByRole("button", { name: /编辑镜像 system-base|Edit image system-base/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /删除镜像 system-base|Delete image system-base/ })).not.toBeInTheDocument();
  });

  it("keeps edit input after backend rejection and permits a corrected retry", async () => {
    mocks.update.mockRejectedValueOnce(new Error("permission denied"));
    renderImages();
    fireEvent.click((await screen.findAllByRole("button", { name: /编辑镜像 custom-cuda|Edit image custom-cuda/ }))[0]);
    const dialog = screen.getByRole("dialog", { name: /编辑镜像|Edit image/ });
    fireEvent.change(within(dialog).getByLabelText(/名称|Name/), { target: { value: "retry-image" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /保存|Save/ }));
    expect(await screen.findByText(/permission denied/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/名称|Name/)).toHaveValue("retry-image");
    fireEvent.click(within(dialog).getByRole("button", { name: /保存|Save/ }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /编辑镜像|Edit image/ })).not.toBeInTheDocument());
  });

  it("requires deletion confirmation and refreshes after a successful deletion", async () => {
    renderImages();
    fireEvent.click((await screen.findAllByRole("button", { name: /删除镜像 custom-cuda|Delete image custom-cuda/ }))[0]);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    const options = mocks.confirm.mock.calls[0][0] as { tone: string; run(): Promise<void> };
    expect(options.tone).toBe("danger");
    await act(async () => { await options.run(); });
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(11);
    expect(mocks.list.mock.calls.length).toBeGreaterThan(1);
  });

  it("reports a rejected deletion while keeping the image available for retry", async () => {
    mocks.remove.mockRejectedValueOnce(new Error("image in use"));
    renderImages();
    fireEvent.click((await screen.findAllByRole("button", { name: /删除镜像 custom-cuda|Delete image custom-cuda/ }))[0]);
    const options = mocks.confirm.mock.calls[0][0] as { run(): Promise<void> };
    await act(async () => { await options.run(); });
    expect(await screen.findByText("image in use")).toBeInTheDocument();
    expect(screen.getAllByText("custom-cuda").length).toBeGreaterThan(0);
  });
});
