import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APP_SETTINGS, setRuntimeSettings } from "../../lib/app-settings";
import { useSshWorkspace } from "../../lib/use-ssh-workspace";
import type { SshConnectionRequest } from "../../lib/types";
import { ToastContext, type ToastContextValue } from "../../lib/use-toast";
import { SshWorkspaceGate, SshWorkspaceProvider } from "./SshWorkspaceProvider";

const dialogModuleLoaded = vi.hoisted(() => vi.fn());
vi.mock("../tasks/AppSshTerminalDialog", () => {
  dialogModuleLoaded();
  return {
    AppSshTerminalDialog: () => (
      <div role="dialog">
        <button role="tab" type="button">SSH session</button>
      </div>
    ),
  };
});

vi.mock("../tasks/SshTerminalTab", () => ({
  SshTerminalTab: ({ tabId }: { tabId: string }) => <div data-testid={`ssh-session-${tabId}`} />,
}));

// The gate only renders for an authenticated desktop runtime; jsdom defaults
// to the web runtime, so pin the capability flags for these tests.
vi.mock("../../lib/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/runtime")>();
  return {
    ...actual,
    browserRuntime: {
      ...actual.browserRuntime,
      runtimeKind: "desktop",
      supportsInAppSsh: true,
      supportsSshPopOut: false,
    },
  };
});

// SshWorkspaceGate consumes the auth state; tests control it through this.
let authedUser: { username: string } | null = { username: "ops" };
vi.mock("../../lib/use-auth", () => ({
  useAuth: () => ({ user: authedUser }),
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

/** Opens a target through the workspace on click, like a task panel entry. */
function OpenButton({ request }: { request: SshConnectionRequest }) {
  const workspace = useSshWorkspace();
  return (
    <button type="button" onClick={() => workspace.openTarget(request)}>
      open-target
    </button>
  );
}

/** Shows whether the workspace still holds tabs (a page-level assertion). */
function TabCountProbe() {
  const workspace = useSshWorkspace();
  return <span data-testid="workspace-tab-count">{workspace.tabs.length}</span>;
}

function renderGate(initiallyAuthed: boolean) {
  authedUser = initiallyAuthed ? { username: "ops" } : null;
  return render(
    <ToastContext.Provider value={toast}>
      <SshWorkspaceProvider>
        <OpenButton request={requestA} />
        <TabCountProbe />
        <SshWorkspaceGate />
      </SshWorkspaceProvider>
    </ToastContext.Provider>,
  );
}

describe("SshWorkspaceProvider", () => {
  beforeEach(() => {
    setRuntimeSettings(DEFAULT_APP_SETTINGS);
    authedUser = { username: "ops" };
    dialogModuleLoaded.mockClear();
  });

  it("defers loading the workspace dialog until a session is opened", async () => {
    renderGate(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(dialogModuleLoaded).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("open-target"));
    await waitFor(() => expect(screen.getByRole("dialog")).not.toBeNull());
    expect(dialogModuleLoaded).toHaveBeenCalledTimes(1);
  });

  it("renders the workspace dialog for an authenticated desktop runtime", async () => {
    renderGate(true);
    fireEvent.click(screen.getByText("open-target"));
    await waitFor(() => expect(screen.getByRole("dialog")).not.toBeNull());
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("does not render or load the workspace dialog while there are no sessions", () => {
    renderGate(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps tabs across gate rerenders and clears them on logout", async () => {
    const view = renderGate(true);
    fireEvent.click(screen.getByText("open-target"));
    await waitFor(() => expect(screen.getByTestId("workspace-tab-count")).toHaveTextContent("1"));

    // Logged out: the gate unmounts the dialog (which closes the native
    // sessions through each tab's cleanup) and resets the workspace state.
    authedUser = null;
    view.rerender(
      <ToastContext.Provider value={toast}>
        <SshWorkspaceProvider>
          <OpenButton request={requestA} />
          <TabCountProbe />
          <SshWorkspaceGate />
        </SshWorkspaceProvider>
      </ToastContext.Provider>,
    );

    await waitFor(() => expect(screen.getByTestId("workspace-tab-count")).toHaveTextContent("0"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
