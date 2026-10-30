import { useEffect, useRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APP_SETTINGS, getRuntimeSettings, setRuntimeSettings } from "../../lib/app-settings";
import { useSshWorkspace } from "../../lib/use-ssh-workspace";
import type { SshConnectionRequest } from "../../lib/types";
import { ToastContext, type ToastContextValue } from "../../lib/use-toast";
import { SshWorkspaceProvider } from "../ssh/SshWorkspaceProvider";
import { AppSshTerminalDialog } from "./AppSshTerminalDialog";

const terminalMock = vi.hoisted(() => ({ requests: [] as Array<{ host: string; password?: string }> }));

vi.mock("./SshTerminalTab", () => ({
  SshTerminalTab: ({ tabId, request }: { tabId: string; request: { host: string; password?: string } }) => {
    terminalMock.requests.push(request);
    return <div data-testid={`ssh-session-${tabId}`} />;
  },
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

/** Opens a target through the workspace once on mount, like a page entry. */
function OpenTargetProbe({ request }: { request: SshConnectionRequest }) {
  const workspace = useSshWorkspace();
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    workspace.openTarget(request);
    // Mount-only: later renders must not re-activate this target over a tab
    // the user opened manually afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function renderWorkspace(initial?: SshConnectionRequest) {
  return render(
    <ToastContext.Provider value={toast}>
      <SshWorkspaceProvider>
        {initial ? <OpenTargetProbe request={initial} /> : null}
        <AppSshTerminalDialog />
      </SshWorkspaceProvider>
    </ToastContext.Provider>,
  );
}

function activeTab(name: string) {
  return screen.getByRole("tab", { name: new RegExp(`${name}，`) });
}

describe("AppSshTerminalDialog", () => {
  beforeEach(() => {
    setRuntimeSettings(DEFAULT_APP_SETTINGS);
    terminalMock.requests.length = 0;
  });

  it("renders nothing while the workspace has no tabs", () => {
    renderWorkspace();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("defaults the manual-tab port and auth mode from SSH settings and resolves through the shared resolver", async () => {
    setRuntimeSettings({
      ...DEFAULT_APP_SETTINGS,
      ssh: {
        ...getRuntimeSettings().ssh,
        defaultPort: 30222,
        defaultUsername: "ops",
        authMode: "key",
        sshKeyPath: "~/.ssh/id_ed25519",
      },
    });
    renderWorkspace(requestA);

    fireEvent.click(screen.getByTitle("新标签"));
    // The port field is pre-filled from settings instead of a hardcoded 22.
    expect(screen.getByLabelText("端口")).toHaveValue("30222");
    expect((screen.getByLabelText("认证方式") as HTMLSelectElement).value).toBe("key");
    expect(screen.getByLabelText("私钥路径")).toHaveValue("~/.ssh/id_ed25519");

    fireEvent.change(screen.getByLabelText("主机"), { target: { value: "10.0.0.9" } });
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "root" } });
    fireEvent.click(screen.getByRole("button", { name: "连接" }));

    const tab = await waitFor(() => activeTab("10.0.0.9"));
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("activates an existing target without creating a duplicate tab", async () => {
    const view = renderWorkspace(requestA);
    await waitFor(() => expect(activeTab("A")).toHaveAttribute("aria-selected", "true"));

    fireEvent.click(screen.getByTitle("新标签"));
    fireEvent.change(screen.getByLabelText("主机"), { target: { value: "10.0.0.9" } });
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "root" } });
    fireEvent.click(screen.getByRole("button", { name: "连接" }));
    const manualTab = await waitFor(() => {
      const tab = activeTab("10.0.0.9");
      expect(tab).toHaveAttribute("aria-selected", "true");
      return tab;
    });
    expect(screen.getAllByRole("tab")).toHaveLength(2);

    // A page opening the same target again must activate the existing tab,
    // never create a second session for it.
    view.rerender(
      <ToastContext.Provider value={toast}>
        <SshWorkspaceProvider>
          <OpenTargetProbe
            request={{
              host: "10.0.0.9",
              port: "22",
              username: "root",
              command: "ssh root@10.0.0.9",
            }}
          />
          <AppSshTerminalDialog />
        </SshWorkspaceProvider>
      </ToastContext.Provider>,
    );

    await waitFor(() => expect(manualTab).toHaveAttribute("aria-selected", "true"));
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("keeps workspace tabs alive when the page that opened them unmounts", async () => {
    const view = renderWorkspace(requestA);
    await waitFor(() => expect(activeTab("A")).toHaveAttribute("aria-selected", "true"));

    // The probe (page-level opener) goes away, as it would on route change.
    view.rerender(
      <ToastContext.Provider value={toast}>
        <SshWorkspaceProvider>
          <AppSshTerminalDialog />
        </SshWorkspaceProvider>
      </ToastContext.Provider>,
    );

    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(activeTab("A")).toHaveAttribute("aria-selected", "true");
  });

  it("falls back to the neighboring tab and closes with the last tab", async () => {
    renderWorkspace(requestA);
    await waitFor(() => expect(activeTab("A")).toHaveAttribute("aria-selected", "true"));

    fireEvent.click(screen.getByTitle("新标签"));
    fireEvent.change(screen.getByLabelText("主机"), { target: { value: "10.0.0.9" } });
    fireEvent.click(screen.getByRole("button", { name: "连接" }));
    await waitFor(() => expect(activeTab("10.0.0.9")).toHaveAttribute("aria-selected", "true"));

    fireEvent.click(screen.getByRole("button", { name: "关闭 10.0.0.9 标签" }));
    await waitFor(() => expect(activeTab("A")).toHaveAttribute("aria-selected", "true"));
    expect(screen.getAllByRole("tab")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "关闭 A 标签" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("clears an unsubmitted password when the new-tab form is dismissed", async () => {
    renderWorkspace(requestA);
    await waitFor(() => expect(activeTab("A")).toHaveAttribute("aria-selected", "true"));

    fireEvent.click(screen.getByTitle("新标签"));
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "secret" } });

    // Dismiss the form and reopen it: the typed password must be gone, while
    // host/port/username may persist for convenience.
    fireEvent.click(screen.getByTitle("新标签"));
    fireEvent.click(screen.getByTitle("新标签"));

    expect((screen.getByLabelText("密码") as HTMLInputElement).value).toBe("");
  });

  it("preserves surrounding whitespace in a manually entered SSH password", async () => {
    renderWorkspace(requestA);
    await waitFor(() => expect(activeTab("A")).toHaveAttribute("aria-selected", "true"));

    fireEvent.click(screen.getByTitle("新标签"));
    fireEvent.change(screen.getByLabelText("主机"), { target: { value: "10.0.0.10" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "  secret \t" } });
    fireEvent.click(screen.getByRole("button", { name: "连接" }));

    await waitFor(() => expect(activeTab("10.0.0.10")).toHaveAttribute("aria-selected", "true"));
    expect(terminalMock.requests.find((request) => request.host === "10.0.0.10")?.password)
      .toBe("  secret \t");
  });

  it("preserves surrounding whitespace in the configured password fallback", async () => {
    setRuntimeSettings({
      ...DEFAULT_APP_SETTINGS,
      ssh: { ...DEFAULT_APP_SETTINGS.ssh, defaultPassword: "  default-secret  " },
    });
    renderWorkspace(requestA);
    await waitFor(() => expect(activeTab("A")).toHaveAttribute("aria-selected", "true"));

    fireEvent.click(screen.getByTitle("新标签"));
    fireEvent.change(screen.getByLabelText("主机"), { target: { value: "10.0.0.11" } });
    fireEvent.click(screen.getByRole("button", { name: "连接" }));

    await waitFor(() => expect(activeTab("10.0.0.11")).toHaveAttribute("aria-selected", "true"));
    expect(terminalMock.requests.find((request) => request.host === "10.0.0.11")?.password)
      .toBe("  default-secret  ");
  });
});
