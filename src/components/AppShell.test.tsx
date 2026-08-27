import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigateMock = vi.fn();
const locationState = vi.hoisted(() => ({ pathname: "/dashboard" }));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useLocation: () => ({ pathname: locationState.pathname, search: "", hash: "", state: null, key: "test" }),
    Outlet: () => <div data-testid="outlet">Page Content</div>,
  };
});

vi.mock("../lib/use-auth", () => ({
  useAuth: () => ({
    token: "Bearer test",
    user: { username: "tester" },
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

vi.mock("../lib/app-update-context", () => ({
  useAppUpdate: () => ({
    state: { status: "idle", dialogOpen: false },
    checkForUpdates: vi.fn(),
    installUpdate: vi.fn(),
    relaunchAfterUpdate: vi.fn(),
    dismissUpdate: vi.fn(),
    ignoreUpdateVersion: vi.fn(),
    openUpdateDialog: vi.fn(),
    closeUpdateDialog: vi.fn(),
    openReleasePage: vi.fn(),
  }),
}));

vi.mock("../lib/use-download-queue", () => ({
  useDownloadQueue: () => ({ items: [], totalProgress: 0, summary: { active: 0, completed: 0, failed: 0 }, clear: vi.fn(), cancel: vi.fn() }),
  formatDownloadProgress: () => "0%",
}));

vi.mock("../lib/commit-queue-context", () => ({
  useCommitQueue: () => ({ items: [], summary: { active: 0, failed: 0 }, clear: vi.fn() }),
}));

vi.mock("../lib/use-toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), notify: vi.fn() }),
}));

vi.mock("./CommandPalette", () => ({
  CommandPalette: ({ open }: { open: boolean }) => (open ? <div data-testid="command-palette">Palette</div> : null),
}));

vi.mock("./TaskNotificationWatcher", () => ({
  TaskNotificationWatcher: () => null,
}));

vi.mock("./BackgroundScheduledTaskRunner", () => ({
  BackgroundScheduledTaskRunner: () => null,
}));

vi.mock("./LanguageSwitch", () => ({
  LanguageSwitch: () => null,
}));

vi.mock("../lib/api", () => ({
  getTransportBlockReason: () => null,
  subscribeTransportPolicy: () => () => {},
}));

vi.mock("../lib/app-settings", () => ({
  APP_SETTINGS_STORAGE_KEY: "test",
  getRuntimeSettings: () => ({ apiUrl: "", monitorDashboardUrl: "" }),
  setRuntimeSettings: vi.fn(),
  saveAccountSettings: vi.fn(async () => ({})),
  GLOBAL_SETTINGS_ACCOUNT_ID: "__global__",
}));

vi.mock("../lib/saved-accounts", () => ({
  resolveSavedAccountId: () => "test-account",
}));

vi.mock("../lib/shell-nav-width", () => ({
  DEFAULT_SHELL_NAV_WIDTH: 220,
  clampShellNavWidth: (w: number) => w,
  readStoredShellNavWidth: () => 220,
  writeStoredShellNavWidth: vi.fn(),
}));

import { AppShell } from "./AppShell";

function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <AppShell />
    </MemoryRouter>,
  );
}

describe("AppShell", () => {
  beforeEach(() => {
    navigateMock.mockReset();
    locationState.pathname = "/dashboard";
  });

  it("renders a skip-to-content link", () => {
    renderShell();
    const skipLink = screen.getByText(/跳到主内容|Skip to main content/);
    expect(skipLink).toBeInTheDocument();
    expect(skipLink.closest("a")).toHaveAttribute("href", "#main-content");
  });

  it("shows a route-specific header description on dashboard", () => {
    renderShell();
    expect(screen.getByText(/查看需要处理的实例、时长和费用|See instances that need attention, runtime, and cost/)).toBeInTheDocument();
  });

  it("renders main content with id main-content", () => {
    renderShell();
    expect(document.getElementById("main-content")).not.toBeNull();
  });

  it("navigates to dashboard on g d key sequence", () => {
    renderShell();
    fireEvent.keyDown(document, { key: "g" });
    fireEvent.keyDown(document, { key: "d" });
    expect(navigateMock).toHaveBeenCalledWith("/dashboard");
  });

  it("navigates to tasks on g t key sequence", () => {
    renderShell();
    fireEvent.keyDown(document, { key: "g" });
    fireEvent.keyDown(document, { key: "t" });
    expect(navigateMock).toHaveBeenCalledWith("/tasks");
  });

  it("opens command palette on Ctrl+K", () => {
    renderShell();
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(screen.getByTestId("command-palette")).toBeInTheDocument();
  });

  it("uses the task list title on task detail routes", () => {
    locationState.pathname = "/tasks/42";
    renderShell();
    expect(screen.getByRole("heading", { level: 1, name: /任务实例|Task Instances/ })).toBeInTheDocument();
    expect(screen.getByText(/对照状态、路径、日志和终端|Compare status, paths, logs, and terminal access/)).toBeInTheDocument();
  });
});
