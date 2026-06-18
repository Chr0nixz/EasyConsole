import { describe, expect, it } from "vitest";

import {
  DEFAULT_SHELL_NAV_WIDTH,
  MAX_SHELL_NAV_WIDTH,
  MIN_SHELL_NAV_WIDTH,
  clampShellNavWidth,
  parseStoredShellNavWidth,
  readStoredShellNavWidth,
  writeStoredShellNavWidth,
} from "./shell-nav-width";

describe("shell-nav-width", () => {
  it("clamps width to supported range", () => {
    expect(clampShellNavWidth(100)).toBe(MIN_SHELL_NAV_WIDTH);
    expect(clampShellNavWidth(500)).toBe(MAX_SHELL_NAV_WIDTH);
    expect(clampShellNavWidth(241.6)).toBe(242);
  });

  it("falls back to default for invalid stored values", () => {
    expect(parseStoredShellNavWidth(null)).toBe(DEFAULT_SHELL_NAV_WIDTH);
    expect(parseStoredShellNavWidth("")).toBe(DEFAULT_SHELL_NAV_WIDTH);
    expect(parseStoredShellNavWidth("bad")).toBe(DEFAULT_SHELL_NAV_WIDTH);
  });

  it("reads and writes through storage", () => {
    const storage = new Map<string, string>();
    const adapter = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    };

    expect(readStoredShellNavWidth(adapter)).toBe(DEFAULT_SHELL_NAV_WIDTH);
    writeStoredShellNavWidth(280, adapter);
    expect(readStoredShellNavWidth(adapter)).toBe(280);
    writeStoredShellNavWidth(999, adapter);
    expect(readStoredShellNavWidth(adapter)).toBe(MAX_SHELL_NAV_WIDTH);
  });
});
