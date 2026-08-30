import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SshConnectionRequest } from "../../lib/types";
import { ToastContext, type ToastContextValue } from "../../lib/use-toast";
import { AppSshTerminalDialog } from "./AppSshTerminalDialog";

vi.mock("./SshTerminalTab", () => ({
  SshTerminalTab: ({ tabId }: { tabId: string }) => <div data-testid={`ssh-session-${tabId}`} />,
}));

const toast: ToastContextValue = {
  notify: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
};

const requestA: SshConnectionRequest = {
  host: "10.0.0.8",
  port: "30222",
  username: "ubuntu",
  taskId: "task-a",
  taskName: "A",
  command: "ssh -p 30222 ubuntu@10.0.0.8",
};

function renderDialog(request: SshConnectionRequest | null, onClose = vi.fn()) {
  return render(
    <ToastContext.Provider value={toast}>
      <AppSshTerminalDialog request={request} onClose={onClose} />
    </ToastContext.Provider>,
  );
}

function activeTab(name: string) {
  return screen.getByRole("tab", { name: new RegExp(`${name}，`) });
}

describe("AppSshTerminalDialog", () => {
  it("keeps a manually opened tab active when the parent rerenders the original request", async () => {
    const view = renderDialog(requestA);
    await waitFor(() => expect(activeTab("A")).toHaveAttribute("aria-selected", "true"));

    fireEvent.click(screen.getByTitle("新标签"));
    fireEvent.change(screen.getByLabelText("主机"), { target: { value: "10.0.0.9" } });
    fireEvent.change(screen.getByLabelText("端口"), { target: { value: "22" } });
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "root" } });
    fireEvent.click(screen.getByRole("button", { name: "连接" }));

    const bTab = await waitFor(() => {
      const tab = activeTab("10.0.0.9");
      expect(tab).toHaveAttribute("aria-selected", "true");
      return tab;
    });
    expect(screen.getAllByRole("tab")).toHaveLength(2);

    view.rerender(
      <ToastContext.Provider value={toast}>
        <AppSshTerminalDialog request={{ ...requestA }} onClose={vi.fn()} />
      </ToastContext.Provider>,
    );

    expect(bTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("activates an existing incoming target without creating a duplicate tab", async () => {
    const view = renderDialog(requestA);
    await waitFor(() => expect(activeTab("A")).toHaveAttribute("aria-selected", "true"));

    fireEvent.click(screen.getByTitle("新标签"));
    fireEvent.change(screen.getByLabelText("主机"), { target: { value: "10.0.0.9" } });
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "root" } });
    fireEvent.click(screen.getByRole("button", { name: "连接" }));
    await waitFor(() => expect(activeTab("10.0.0.9")).toHaveAttribute("aria-selected", "true"));

    view.rerender(
      <ToastContext.Provider value={toast}>
        <AppSshTerminalDialog
          request={{
            host: "10.0.0.9",
            port: "22",
            username: "root",
            command: "ssh root@10.0.0.9",
          }}
          onClose={vi.fn()}
        />
      </ToastContext.Provider>,
    );

    await waitFor(() => expect(activeTab("10.0.0.9")).toHaveAttribute("aria-selected", "true"));
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("falls back to the neighboring tab and closes the dialog after the last tab", async () => {
    const onClose = vi.fn();
    renderDialog(requestA, onClose);
    await waitFor(() => expect(activeTab("A")).toHaveAttribute("aria-selected", "true"));

    fireEvent.click(screen.getByTitle("新标签"));
    fireEvent.change(screen.getByLabelText("主机"), { target: { value: "10.0.0.9" } });
    fireEvent.click(screen.getByRole("button", { name: "连接" }));
    await waitFor(() => expect(activeTab("10.0.0.9")).toHaveAttribute("aria-selected", "true"));

    fireEvent.click(screen.getByRole("button", { name: "关闭 10.0.0.9 标签" }));
    await waitFor(() => expect(activeTab("A")).toHaveAttribute("aria-selected", "true"));
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "关闭 A 标签" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
