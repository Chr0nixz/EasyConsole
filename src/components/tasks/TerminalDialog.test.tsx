import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { browserRuntime } from "../../lib/runtime";
import { ToastContext, type ToastContextValue } from "../../lib/use-toast";
import { TerminalDialog } from "./TerminalDialog";

vi.mock("../../lib/use-auth", () => ({
  useAuth: () => ({
    token: "Bearer test",
    user: { username: "alice" },
    ready: true,
    restoringSession: false,
    savedAccounts: [],
    login: vi.fn(),
    loginSaved: vi.fn(),
    forgetSavedAccount: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
  }),
}));

const toast: ToastContextValue = {
  notify: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
};

function setDesktopRuntime(value: boolean) {
  // TerminalDialog gates on the SSH capability flags (derived from runtimeKind
  // in production). Override the capability getters directly so desktop/web
  // behavior is exercised without depending on the native runtime probe.
  const flags = {
    isDesktop: value,
    isMobile: false,
    supportsInAppSsh: value,
    supportsSshPopOut: value,
    supportsSystemTerminal: value,
    supportsTray: value,
    supportsUpdater: value,
    supportsFileReveal: value,
  };
  for (const [key, flag] of Object.entries(flags)) {
    Object.defineProperty(browserRuntime, key, {
      value: flag,
      configurable: true,
    });
  }
}

function setMobileRuntime() {
  // Mobile has in-app SSH (russh NDK) but not system terminal, VS Code, tray, or updater.
  const flags = {
    isDesktop: false,
    isMobile: true,
    supportsInAppSsh: true,
    supportsSshPopOut: false,
    supportsSystemTerminal: false,
    supportsTray: false,
    supportsUpdater: false,
    supportsFileReveal: false,
  };
  for (const [key, flag] of Object.entries(flags)) {
    Object.defineProperty(browserRuntime, key, {
      value: flag,
      configurable: true,
    });
  }
}

function renderDialog() {
  return render(
    <ToastContext.Provider value={toast}>
      <TerminalDialog
        task={{
          id: 1,
          task_id: "task-1",
          name: "demo",
          ip: "10.0.0.8",
          port: 30222,
          user: { username: "alice" },
        }}
        onClose={vi.fn()}
      />
    </ToastContext.Provider>,
  );
}

describe("TerminalDialog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setDesktopRuntime(false);
  });

  it("shows SSH information and copyable command in the web runtime", () => {
    setDesktopRuntime(false);
    renderDialog();

    expect(screen.getByRole("dialog")).toHaveTextContent("SSH 连接信息 demo");
    expect(screen.getByText("10.0.0.8")).toBeInTheDocument();
    expect(screen.getByText("30222")).toBeInTheDocument();
    expect(screen.getByText("ubuntu")).toBeInTheDocument();
    expect(screen.getByText("ssh -p 30222 ubuntu@10.0.0.8")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "应用内 SSH" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "VS Code" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "系统终端" })).not.toBeInTheDocument();
  });

  it("shows desktop SSH entry points in the desktop runtime", async () => {
    setDesktopRuntime(true);
    const openSystemSshTerminal = vi.spyOn(browserRuntime, "openSystemSshTerminal").mockResolvedValue(undefined);
    const openVscodeSsh = vi.spyOn(browserRuntime, "openVscodeSsh").mockResolvedValue(undefined);
    renderDialog();

    expect(screen.getByRole("button", { name: "应用内 SSH" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "VS Code" }));
    fireEvent.click(screen.getByRole("button", { name: "系统终端" }));

    await waitFor(() => {
      expect(openVscodeSsh).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "task-1", command: "ssh -p 30222 ubuntu@10.0.0.8" }),
      );
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "VS Code" })).toBeEnabled());
    expect(openSystemSshTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", command: "ssh -p 30222 ubuntu@10.0.0.8" }),
    );
  });

  it("shows in-app SSH button but hides desktop-only entry points in the mobile runtime", () => {
    setMobileRuntime();
    renderDialog();

    expect(screen.getByRole("button", { name: "应用内 SSH" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "VS Code" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "系统终端" })).not.toBeInTheDocument();
  });
});
