import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../components/Toast";
import { RunLoggerContext } from "../lib/use-run-logger";

const mocks = vi.hoisted(() => ({
  changePassword: vi.fn(),
  auth: {
    user: { username: "alice", name: "Alice" },
    token: "Bearer x",
    ready: true,
    restoringSession: false,
    savedAccounts: [],
    login: vi.fn(),
    loginSaved: vi.fn(),
    forgetSavedAccount: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
  },
  appUpdate: {
    state: { status: "idle" as const },
    checkForUpdates: vi.fn(),
    installUpdate: vi.fn(),
    relaunchAfterUpdate: vi.fn(),
    dismissUpdate: vi.fn(),
    openUpdateDialog: vi.fn(),
    closeUpdateDialog: vi.fn(),
    openReleasePage: vi.fn(),
  },
}));

vi.mock("../lib/api", () => ({
  authApi: {
    changePassword: (...args: unknown[]) => mocks.changePassword(...args),
  },
  setApiBaseUrl: vi.fn(),
}));

vi.mock("../lib/use-auth", () => ({
  useAuth: () => mocks.auth,
}));

vi.mock("../lib/app-update-context", () => ({
  useAppUpdate: () => mocks.appUpdate,
}));

vi.mock("../lib/use-confirm-action", () => ({
  useConfirmAction: () => ({
    confirm: vi.fn(),
    confirmDialog: null,
  }),
}));

import { SettingsPage } from "./SettingsPage";

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter>
      <RunLoggerContext.Provider value={{ log: async () => undefined }}>
        <ToastProvider>
          <QueryClientProvider client={client}>
            <SettingsPage />
          </QueryClientProvider>
        </ToastProvider>
      </RunLoggerContext.Provider>
    </MemoryRouter>,
  );
}

describe("SettingsPage", () => {
  beforeEach(() => {
    mocks.changePassword.mockReset();
    mocks.changePassword.mockResolvedValue(undefined);
  });

  it("validates password fields before calling the API", async () => {
    renderSettings();

    fireEvent.click(screen.getByRole("button", { name: /^修改密码$|^Change password$/ }));
    expect(await screen.findByText(/请填写当前密码与新密码|Enter the current and new passwords/)).toBeInTheDocument();
    expect(mocks.changePassword).not.toHaveBeenCalled();

    const [oldPassword, newPassword, confirmPassword] = screen.getAllByDisplayValue("");
    fireEvent.change(oldPassword, { target: { value: "old-secret" } });
    fireEvent.change(newPassword, { target: { value: "new-secret" } });
    fireEvent.change(confirmPassword, { target: { value: "mismatch" } });
    fireEvent.click(screen.getByRole("button", { name: /^修改密码$|^Change password$/ }));

    expect(await screen.findByText(/两次输入的新密码不一致|New password confirmation does not match/)).toBeInTheDocument();
    expect(mocks.changePassword).not.toHaveBeenCalled();
  });

  it("submits a matching password change", async () => {
    renderSettings();

    const inputs = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
    // Change-password fields are the first three password inputs on the page when authenticated.
    fireEvent.change(inputs[0], { target: { value: "old-secret" } });
    fireEvent.change(inputs[1], { target: { value: "new-secret" } });
    fireEvent.change(inputs[2], { target: { value: "new-secret" } });
    fireEvent.click(screen.getByRole("button", { name: /^修改密码$|^Change password$/ }));

    await waitFor(() =>
      expect(mocks.changePassword).toHaveBeenCalledWith({
        old_password: "old-secret",
        new_password: "new-secret",
      }),
    );
    expect(await screen.findByText(/密码已修改|Password changed/)).toBeInTheDocument();
  });
});
