import { afterEach, describe, expect, it, vi } from "vitest";

const MAC_WEBKIT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

async function importWithUserAgent(userAgent: string) {
  vi.resetModules();
  vi.stubGlobal("navigator", { ...window.navigator, userAgent });
  return import("./app-settings");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  delete document.documentElement.dataset.titlebar;
});

describe("macOS settings defaults", () => {
  it("keeps the app running when its window closes and uses a font macOS has", async () => {
    const { DEFAULT_APP_SETTINGS, SSH_FONT_PRESETS, normalizeAppSettings } = await importWithUserAgent(MAC_WEBKIT_UA);

    expect(DEFAULT_APP_SETTINGS.desktopCloseToTray).toBe(true);
    expect(DEFAULT_APP_SETTINGS.desktopClosePrompt).toBe(false);
    expect(DEFAULT_APP_SETTINGS.ssh.terminal.fontPreset).toBe("menlo");
    expect(DEFAULT_APP_SETTINGS.ssh.terminal.fontFamily).toBe(
      SSH_FONT_PRESETS.find((preset) => preset.id === "menlo")?.value,
    );
    expect(DEFAULT_APP_SETTINGS.ssh.terminal.fontFamily.split(",")[0]).toBe("Menlo");

    // Settings saved before the user chose fall back to the macOS defaults…
    const legacy = normalizeAppSettings({ ssh: { terminal: {} } as never });
    expect(legacy.desktopCloseToTray).toBe(true);
    expect(legacy.desktopClosePrompt).toBe(false);
    expect(legacy.ssh.terminal.fontPreset).toBe("menlo");
    // …while an explicit choice always wins.
    const chosen = normalizeAppSettings({ desktopCloseToTray: false, desktopClosePrompt: true });
    expect(chosen.desktopCloseToTray).toBe(false);
    expect(chosen.desktopClosePrompt).toBe(true);
  });

  it("leaves Windows and Linux defaults unchanged", async () => {
    const { DEFAULT_APP_SETTINGS, normalizeAppSettings } = await importWithUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)",
    );

    expect(DEFAULT_APP_SETTINGS.desktopCloseToTray).toBe(false);
    expect(DEFAULT_APP_SETTINGS.desktopClosePrompt).toBe(true);
    expect(DEFAULT_APP_SETTINGS.ssh.terminal.fontPreset).toBe("consolas");
    expect(normalizeAppSettings({ desktopCloseToTray: "yes" as never }).desktopCloseToTray).toBe(false);
    expect(normalizeAppSettings({ desktopClosePrompt: 0 as never }).desktopClosePrompt).toBe(true);
  });
});

describe("overlay title bar drag regions", () => {
  it("only marks shell chrome as draggable when the window has an overlay title bar", async () => {
    const { titleBarDragRegion, usesOverlayTitleBar } = await import("./window-chrome");

    expect(usesOverlayTitleBar()).toBe(false);
    expect(titleBarDragRegion()).toEqual({});

    document.documentElement.dataset.titlebar = "overlay";
    expect(usesOverlayTitleBar()).toBe(true);
    expect(titleBarDragRegion()).toEqual({ "data-tauri-drag-region": "deep" });
  });

  it("keeps windows on other platforms on their native title bar", async () => {
    const { applyWindowChrome } = await import("./window-chrome");

    // jsdom is the web runtime, never the packaged macOS app.
    applyWindowChrome("main");
    expect(document.documentElement.dataset.titlebar).toBeUndefined();
  });
});
