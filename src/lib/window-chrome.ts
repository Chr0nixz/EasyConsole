import { browserRuntime } from "./runtime";

const RESIZE_SETTLE_MS = 150;

/**
 * The macOS main window uses an overlay title bar (`tauri.macos.conf.json`):
 * the traffic lights float over the sidebar header and the shell provides its
 * own drag regions. `data-titlebar="overlay"` lets CSS keep the lights clear,
 * and `data-fullscreen` releases that space while macOS hides them.
 *
 * The attribute is set synchronously so the first render already sees it.
 */
export function applyWindowChrome(windowLabel: string) {
  if (!browserRuntime.isMacDesktop || windowLabel !== "main") return;
  const root = document.documentElement;
  root.dataset.titlebar = "overlay";

  void (async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const appWindow = getCurrentWindow();
      let generation = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      function sync() {
        const request = ++generation;
        void appWindow.isFullscreen().then((fullscreen) => {
          if (request !== generation) return;
          root.toggleAttribute("data-fullscreen", fullscreen);
        }).catch((error: unknown) => console.warn("Failed to read full screen state.", error));
      }
      await appWindow.onResized(() => {
        clearTimeout(timer);
        timer = setTimeout(sync, RESIZE_SETTLE_MS);
      });
      sync();
    } catch (error) {
      // Cosmetic only: without it the sidebar keeps its traffic-light inset.
      console.warn("Failed to track full screen state.", error);
    }
  })();
}

export function usesOverlayTitleBar() {
  return typeof document !== "undefined" && document.documentElement.dataset.titlebar === "overlay";
}

/**
 * Spread onto shell chrome (sidebar header, page header) so it drags the
 * window like a native title bar. Buttons and inputs inside stay clickable.
 * Empty elsewhere: windows with native title bars keep normal behavior.
 */
export function titleBarDragRegion(): { "data-tauri-drag-region"?: "deep" } {
  return usesOverlayTitleBar() ? { "data-tauri-drag-region": "deep" } : {};
}
