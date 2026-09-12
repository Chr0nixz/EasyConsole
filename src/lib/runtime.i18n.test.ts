import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));

// `runtime.ts` calls `isTauri()` at module scope, so the mock must be in place
// before the import below is evaluated.
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => mocks.isTauri(),
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

import { setNativeLocale } from "./runtime";

/**
 * The native side cannot localize anything unless the webview tells it which
 * language is active. A rename of the command or its argument would fail
 * silently (the call is caught and logged), leaving every Rust-produced string
 * in the wrong language, so the contract is pinned here.
 */
describe("setNativeLocale", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.isTauri.mockReset();
    mocks.isTauri.mockReturnValue(true);
  });

  it("pushes the locale through the set_locale command", async () => {
    await setNativeLocale("en-US");

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("set_locale", { locale: "en-US" });
  });

  it("is a no-op outside the desktop runtime", async () => {
    mocks.isTauri.mockReturnValue(false);

    await setNativeLocale("zh-CN");

    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("does not reject when the native side refuses the command", async () => {
    mocks.invoke.mockRejectedValue(new Error("set_locale not found"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(setNativeLocale("en-US")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });
});
