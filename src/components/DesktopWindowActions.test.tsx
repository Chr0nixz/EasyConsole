import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../lib/i18n";
import { DesktopWindowActions } from "./DesktopWindowActions";
import { ToastProvider } from "./Toast";

const native = vi.hoisted(() => ({
  close: new Set<() => void>(),
  settings: new Set<() => void>(),
  completeClose: vi.fn(async () => undefined),
  token: null as string | null,
}));

vi.mock("../lib/runtime", () => ({
  browserRuntime: {
    isMacDesktop: true,
    storage: { get: async () => "en-US" },
    onDesktopCloseRequested: async (listener: () => void) => {
      native.close.add(listener);
      return () => native.close.delete(listener);
    },
    onDesktopOpenSettings: async (listener: () => void) => {
      native.settings.add(listener);
      return () => native.settings.delete(listener);
    },
    completeDesktopClosePrompt: native.completeClose,
  },
}));

vi.mock("../lib/use-auth", () => ({ useAuth: () => ({ token: native.token, user: null }) }));

function Harness() {
  return (
    <MemoryRouter initialEntries={["/login"]}>
      <I18nProvider syncNative={false}>
        <ToastProvider>
          <DesktopWindowActions />
          <Routes>
            <Route path="/login" element={<h1>Sign in</h1>} />
            <Route path="/login/settings" element={<h1>Connection settings</h1>} />
            <Route path="/settings" element={<h1>Account settings</h1>} />
          </Routes>
        </ToastProvider>
      </I18nProvider>
    </MemoryRouter>
  );
}

describe("native desktop window actions", () => {
  beforeEach(() => {
    native.token = null;
    native.completeClose.mockClear();
  });

  it("opens settings from sign-in and switches to account settings after authentication", async () => {
    const { rerender, unmount } = render(<Harness />);
    await act(async () => native.settings.forEach((listener) => listener()));
    expect(screen.getByRole("heading", { name: "Connection settings" })).toBeVisible();

    native.token = "test-token";
    rerender(<Harness />);
    await act(async () => native.settings.forEach((listener) => listener()));
    expect(screen.getByRole("heading", { name: "Account settings" })).toBeVisible();
    unmount();
    expect(native.settings.size).toBe(0);
  });

  it("handles a native close request before sign-in", async () => {
    render(<Harness />);
    await act(async () => native.close.forEach((listener) => listener()));
    expect(screen.getByRole("dialog", { name: "Close EasyConsole" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Hide window" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(native.completeClose).toHaveBeenCalledWith("tray");
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });
});
