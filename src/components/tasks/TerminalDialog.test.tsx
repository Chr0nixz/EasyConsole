import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { browserRuntime } from "../../lib/runtime";
import { ToastContext, type ToastContextValue } from "../../lib/use-toast";
import { TerminalDialog } from "./TerminalDialog";

const toast: ToastContextValue = {
  notify: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
};

function setDesktopRuntime(value: boolean) {
  Object.defineProperty(browserRuntime, "isDesktop", {
    value,
    configurable: true,
  });
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
    expect(screen.queryByRole("button", { name: "系统终端" })).not.toBeInTheDocument();
  });

  it("shows both desktop SSH entry points in the desktop runtime", () => {
    setDesktopRuntime(true);
    const openSshSession = vi.spyOn(browserRuntime, "openSshSession").mockResolvedValue(undefined);
    const openSystemSshTerminal = vi.spyOn(browserRuntime, "openSystemSshTerminal").mockResolvedValue(undefined);
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "应用内 SSH" }));
    fireEvent.click(screen.getByRole("button", { name: "系统终端" }));

    expect(openSshSession).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1", command: "ssh -p 30222 ubuntu@10.0.0.8" }));
    expect(openSystemSshTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", command: "ssh -p 30222 ubuntu@10.0.0.8" }),
    );
  });
});
