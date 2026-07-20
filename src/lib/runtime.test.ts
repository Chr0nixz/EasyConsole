import { afterEach, describe, expect, it } from "vitest";

import { browserRuntime, getRuntimeKind, initRuntimeKind } from "./runtime";

function resetCapabilityGetters() {
  // The production getters read a module-level runtimeKind; restore them after
  // individual tests override them so later tests see fresh state.
  const defaults = {
    isDesktop: false,
    isMobile: false,
    runtimeKind: "web" as const,
    runLogChannel: "web" as const,
    supportsTray: false,
    supportsSystemTerminal: false,
    supportsInAppSsh: false,
    supportsSshPopOut: false,
    supportsUpdater: false,
    supportsFileReveal: false,
  };
  for (const [key, value] of Object.entries(defaults)) {
    Object.defineProperty(browserRuntime, key, {
      get() {
        return value;
      },
      configurable: true,
    });
  }
}

describe("runtime kind resolution", () => {
  afterEach(() => {
    resetCapabilityGetters();
  });

  it("defaults to the web runtime kind in non-Tauri environments", async () => {
    await initRuntimeKind();
    expect(getRuntimeKind()).toBe("web");
  });

  it("initRuntimeKind resolves even when called multiple times", async () => {
    const first = initRuntimeKind();
    const second = initRuntimeKind();
    expect(first).toBe(second);
    await first;
    expect(getRuntimeKind()).toBe("web");
  });

  it("exposes web capability flags in the web runtime", async () => {
    await initRuntimeKind();
    expect(browserRuntime.isDesktop).toBe(false);
    expect(browserRuntime.isMobile).toBe(false);
    expect(browserRuntime.runLogChannel).toBe("web");
    expect(browserRuntime.supportsTray).toBe(false);
    expect(browserRuntime.supportsSystemTerminal).toBe(false);
    expect(browserRuntime.supportsInAppSsh).toBe(false);
    expect(browserRuntime.supportsSshPopOut).toBe(false);
    expect(browserRuntime.supportsUpdater).toBe(false);
    expect(browserRuntime.supportsFileReveal).toBe(false);
  });

  it("exposes full desktop capability flags when running on desktop", () => {
    Object.defineProperty(browserRuntime, "isDesktop", { get: () => true, configurable: true });
    Object.defineProperty(browserRuntime, "isMobile", { get: () => false, configurable: true });
    Object.defineProperty(browserRuntime, "runtimeKind", { get: () => "desktop", configurable: true });
    Object.defineProperty(browserRuntime, "runLogChannel", { get: () => "tauri", configurable: true });
    Object.defineProperty(browserRuntime, "supportsTray", { get: () => true, configurable: true });
    Object.defineProperty(browserRuntime, "supportsSystemTerminal", { get: () => true, configurable: true });
    Object.defineProperty(browserRuntime, "supportsInAppSsh", { get: () => true, configurable: true });
    Object.defineProperty(browserRuntime, "supportsSshPopOut", { get: () => true, configurable: true });
    Object.defineProperty(browserRuntime, "supportsUpdater", { get: () => true, configurable: true });
    Object.defineProperty(browserRuntime, "supportsFileReveal", { get: () => true, configurable: true });

    expect(browserRuntime.isDesktop).toBe(true);
    expect(browserRuntime.isMobile).toBe(false);
    expect(browserRuntime.runtimeKind).toBe("desktop");
    expect(browserRuntime.runLogChannel).toBe("tauri");
    expect(browserRuntime.supportsTray).toBe(true);
    expect(browserRuntime.supportsInAppSsh).toBe(true);
    expect(browserRuntime.supportsSshPopOut).toBe(true);
    expect(browserRuntime.supportsUpdater).toBe(true);
  });

  it("exposes degraded capability flags when running on mobile (phase 1)", () => {
    Object.defineProperty(browserRuntime, "isDesktop", { get: () => false, configurable: true });
    Object.defineProperty(browserRuntime, "isMobile", { get: () => true, configurable: true });
    Object.defineProperty(browserRuntime, "runtimeKind", { get: () => "mobile", configurable: true });
    Object.defineProperty(browserRuntime, "runLogChannel", { get: () => "mobile", configurable: true });
    Object.defineProperty(browserRuntime, "supportsTray", { get: () => false, configurable: true });
    Object.defineProperty(browserRuntime, "supportsSystemTerminal", { get: () => false, configurable: true });
    Object.defineProperty(browserRuntime, "supportsInAppSsh", { get: () => true, configurable: true });
    Object.defineProperty(browserRuntime, "supportsSshPopOut", { get: () => false, configurable: true });
    Object.defineProperty(browserRuntime, "supportsUpdater", { get: () => false, configurable: true });
    Object.defineProperty(browserRuntime, "supportsFileReveal", { get: () => false, configurable: true });

    expect(browserRuntime.isDesktop).toBe(false);
    expect(browserRuntime.isMobile).toBe(true);
    expect(browserRuntime.runtimeKind).toBe("mobile");
    expect(browserRuntime.runLogChannel).toBe("mobile");
    // Mobile supports in-app SSH via russh NDK; tray, updater, system terminal, pop-out remain desktop-only.
    expect(browserRuntime.supportsTray).toBe(false);
    expect(browserRuntime.supportsSystemTerminal).toBe(false);
    expect(browserRuntime.supportsInAppSsh).toBe(true);
    expect(browserRuntime.supportsSshPopOut).toBe(false);
    expect(browserRuntime.supportsUpdater).toBe(false);
    expect(browserRuntime.supportsFileReveal).toBe(false);
  });
});
