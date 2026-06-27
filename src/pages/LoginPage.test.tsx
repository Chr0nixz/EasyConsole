import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => ({
  token: null as string | null,
  ready: true,
  savedAccounts: [] as Array<{ id: string; username: string; token: string }>,
  login: vi.fn(),
  loginSaved: vi.fn(),
  forgetSavedAccount: vi.fn(),
  logout: vi.fn(),
  refreshUser: vi.fn(),
  user: null,
}));

vi.mock("../lib/use-auth", () => ({
  useAuth: () => authMock,
}));

vi.mock("../lib/saved-accounts", () => ({
  getSavedAccountLabel: (account: { username: string }) => account.username,
}));

vi.mock("../components/LanguageSwitch", () => ({
  LanguageSwitch: () => null,
}));

vi.mock("../components/DataState", () => ({
  LoadingState: () => <div>Loading</div>,
}));

import { LoginPage } from "./LoginPage";

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <LoginPage />
    </MemoryRouter>,
  );
}

describe("LoginPage", () => {
  beforeEach(() => {
    authMock.token = null;
    authMock.ready = true;
    authMock.savedAccounts = [];
    authMock.login.mockReset();
    authMock.loginSaved.mockReset();
    authMock.forgetSavedAccount.mockReset();
  });

  it("renders password form when no saved accounts", () => {
    renderLogin();
    expect(screen.getByText(/登录控制台|Sign In/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^登录$|^Sign in$/ })).toBeInTheDocument();
  });

  it("shows saved accounts when available", () => {
    authMock.savedAccounts = [{ id: "acc1", username: "alice", token: "Bearer x" }];
    renderLogin();
    expect(screen.getAllByText("alice").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: /直接登录|Quick sign in/ })).toBeInTheDocument();
  });

  it("displays error when login fails", async () => {
    authMock.login.mockRejectedValue(new Error("Invalid credentials"));
    renderLogin();

    fireEvent.change(screen.getByLabelText(/用户名|Username/i), { target: { value: "alice" } });
    fireEvent.change(screen.getByLabelText(/密码|Password/i), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /^登录$|^Sign in$/ }));

    await waitFor(() => expect(screen.getByText("Invalid credentials")).toBeInTheDocument());
  });

  it("calls login with username and password on submit", async () => {
    authMock.login.mockResolvedValue(undefined);
    renderLogin();

    fireEvent.change(screen.getByLabelText(/用户名|Username/i), { target: { value: "bob" } });
    fireEvent.change(screen.getByLabelText(/密码|Password/i), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: /^登录$|^Sign in$/ }));

    await waitFor(() => expect(authMock.login).toHaveBeenCalledWith("bob", "secret"));
  });
});
