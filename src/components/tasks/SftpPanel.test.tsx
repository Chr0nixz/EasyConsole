import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { open, save } from "@tauri-apps/plugin-dialog";

import { I18nProvider } from "../../lib/i18n";
import { browserRuntime } from "../../lib/runtime";
import { ToastContext, type ToastContextValue } from "../../lib/use-toast";
import type { SftpEntry } from "../../lib/types";
import { SftpPanel } from "./SftpPanel";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

const toast: ToastContextValue = {
  notify: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
};

function makeEntry(overrides: Partial<SftpEntry> = {}): SftpEntry {
  return {
    name: "big.bin",
    longName: "-rw-r--r--",
    isDir: false,
    isFile: true,
    isSymlink: false,
    size: 1024,
    modifiedAt: 0,
    permissions: "0644",
    ...overrides,
  };
}

function renderPanel() {
  return render(
    <ToastContext.Provider value={toast}>
      <I18nProvider>
        <SftpPanel sessionId="session-1" />
      </I18nProvider>
    </ToastContext.Provider>,
  );
}

describe("SftpPanel", () => {
  beforeEach(() => {
    vi.spyOn(browserRuntime, "onSftpProgress").mockResolvedValue(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("keeps the previous listing when navigation fails and retries the failed path", async () => {
    const sftpList = vi.spyOn(browserRuntime, "sftpList").mockResolvedValueOnce([makeEntry()]).mockRejectedValueOnce(new Error("No such file"));

    renderPanel();

    // Initial listing succeeds and shows the file.
    await waitFor(() => expect(screen.getByText("big.bin")).toBeInTheDocument());

    // Navigate to a bad path.
    fireEvent.change(screen.getByPlaceholderText(/路径|Path/), { target: { value: "/nope" } });
    fireEvent.click(screen.getByRole("button", { name: /打开|Open/ }));

    // The failure is mapped to actionable copy and the old listing survives.
    const banner = await screen.findByText(/路径不存在|Path not found/);
    expect(banner).toBeInTheDocument();
    expect(screen.getByText("big.bin")).toBeInTheDocument();

    // Retry re-requests the failed path.
    sftpList.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole("button", { name: /重试|Retry/ }));
    await waitFor(() => expect(sftpList).toHaveBeenLastCalledWith("session-1", "/nope"));
    await waitFor(() => expect(screen.queryByText(/路径不存在|Path not found/)).not.toBeInTheDocument());
  });

  it("maps permission failures to localized guidance", async () => {
    vi.spyOn(browserRuntime, "sftpList").mockRejectedValue(new Error("Permission denied"));

    renderPanel();

    expect(await screen.findByText(/权限不足|Permission denied/)).toBeInTheDocument();
  });

  it("reports a canceled upload as canceled instead of an error", async () => {
    vi.spyOn(browserRuntime, "sftpList").mockResolvedValue([]);
    vi.spyOn(browserRuntime, "sftpUpload").mockResolvedValue({
      transferId: "t-1",
      operation: "upload",
      status: "canceled",
      transferred: 0,
      total: 0,
    });
    (open as Mock).mockResolvedValue("/tmp/new.bin");

    renderPanel();
    await waitFor(() => expect(screen.getByRole("button", { name: /上传|Upload/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /上传|Upload/ }));

    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(
      expect.stringMatching(/传输已取消|Transfer canceled/),
      "new.bin",
    ));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("confirms a finished download with an open-folder action", async () => {
    vi.spyOn(browserRuntime, "sftpList").mockResolvedValue([makeEntry()]);
    const sftpDownload = vi.spyOn(browserRuntime, "sftpDownload").mockResolvedValue({
      transferId: "t",
      operation: "download",
      status: "completed",
      transferred: 1,
      total: 1,
    });
    const revealLocalPath = vi.spyOn(browserRuntime, "revealLocalPath").mockResolvedValue(undefined);
    (save as Mock).mockResolvedValue("/tmp/big.bin");

    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /big\.bin/ }));
    fireEvent.click(screen.getByRole("button", { name: /下载|Download/ }));

    const successMock = toast.success as unknown as Mock;
    await waitFor(() => expect(successMock).toHaveBeenCalled());
    const [title, , action] = successMock.mock.calls[0];
    expect(String(title)).toMatch(/下载完成|Download complete/);
    expect(action).toMatchObject({ label: expect.stringMatching(/打开所在文件夹|Open folder/) });
    action.onClick();
    expect(revealLocalPath).toHaveBeenCalledWith("/tmp/big.bin");
    expect(sftpDownload).toHaveBeenCalledWith("session-1", "~/big.bin", "/tmp/big.bin");
  });

  it("keeps the parent-directory control out of the path form submission", async () => {
    vi.spyOn(browserRuntime, "sftpList").mockResolvedValue([makeEntry()]);

    renderPanel();

    const parentButton = await screen.findByRole("button", { name: /上级目录|Parent/ });
    expect(parentButton).toHaveAttribute("type", "button");
    expect(within(parentButton).getByText(/上级目录|Parent/)).toBeInTheDocument();
  });
});
