import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigateMock = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useLocation: () => ({ pathname: "/dashboard", search: "", hash: "", state: null, key: "test" }),
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
  useAppUpdate: () => ({ updateAvailable: false, applyUpdate: vi.fn(), dismiss: vi.fn() }),
}));

vi.mock("../lib/download-queue-context", () => ({
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
  });

  it("renders a skip-to-content link", () => {
    renderShell();
    const skipLink = screen.getByText(/跳到主内容|Skip to main content/);
    expect(skipLink).toBeInTheDocument();
    expect(skipLink.closest("a")).toHaveAttribute("href", "#main-content");
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
});
