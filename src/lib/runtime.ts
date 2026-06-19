import { isTauri } from "@tauri-apps/api/core";

import { i18nText } from "./i18n-text";
import type {
  RuntimeHttpRequest,
  RuntimeHttpResponse,
  RuntimeKind,
  RuntimeLogChannel,
  RuntimeStorage,
  RuntimeSystemNotification,
  RuntimeSystemNotificationPermission,
  RuntimeSystemNotificationResult,
  RuntimeTransport,
  RuntimeWebSocket,
  SshSessionEvent,
  UploadProgress,
} from "./types";

export const RUNTIME_SOCKET_OPEN = 1;
const RUNTIME_SOCKET_CONNECTING = 0;
const RUNTIME_SOCKET_CLOSING = 2;
const RUNTIME_SOCKET_CLOSED = 3;

/**
 * Resolved runtime kind. Defaults to "web" and is filled in by
 * {@link initRuntimeKind} before the renderer mounts, so the desktop/mobile
 * distinction is known before any UI renders. In non-Tauri runtimes this stays
 * "web" and init resolves immediately.
 */
let runtimeKind: RuntimeKind = "web";
let runtimeKindReady: Promise<void> | null = null;

/**
 * Resolve the native runtime kind once. Safe to call multiple times; subsequent
 * calls return the same promise. On web it resolves synchronously (no IPC).
 * On Tauri it queries the `runtime_platform` command to distinguish desktop
 * from mobile, since `isTauri()` is true for both.
 */
export function initRuntimeKind(): Promise<void> {
  if (runtimeKindReady) return runtimeKindReady;
  runtimeKindReady = (async () => {
    if (!isTauri()) {
      runtimeKind = "web";
      return;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      // Race the IPC so a hung command never blocks renderer startup.
      const platform = await Promise.race([
        invoke<string>("runtime_platform"),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      runtimeKind = platform === "mobile" || platform === "desktop" ? platform : "desktop";
    } catch {
      runtimeKind = "desktop";
    }
  })();
  return runtimeKindReady;
}

export function getRuntimeKind(): RuntimeKind {
  return runtimeKind;
}

const localStorageAdapter: RuntimeStorage = {
  async get(key) {
    return window.localStorage.getItem(key);
  },
  async set(key, value) {
    window.localStorage.setItem(key, value);
  },
  async remove(key) {
    window.localStorage.removeItem(key);
  },
};

const tauriStorageAdapter: RuntimeStorage = {
  async get(key) {
    try {
      return await invokeTauriCommand<string | null>("runtime_storage_get", { key });
    } catch (error) {
      console.warn("Tauri storage get failed, falling back to localStorage.", error);
      return localStorageAdapter.get(key);
    }
  },
  async set(key, value) {
    try {
      await invokeTauriCommand("runtime_storage_set", { key, value });
    } catch (error) {
      console.warn("Tauri storage set failed, falling back to localStorage.", error);
      await localStorageAdapter.set(key, value);
    }
  },
  async remove(key) {
    try {
      await invokeTauriCommand("runtime_storage_remove", { key });
    } catch (error) {
      console.warn("Tauri storage remove failed, falling back to localStorage.", error);
      await localStorageAdapter.remove(key);
    }
  },
};

function buildUrl(url: string, query?: Record<string, unknown>) {
  const next = new URL(url, window.location.origin);
  Object.entries(query ?? {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    next.searchParams.set(key, String(value));
  });
  return next.toString();
}

function isFormData(body: unknown): body is FormData {
  return typeof FormData !== "undefined" && body instanceof FormData;
}

function normalizeBody(body: unknown, headers: Record<string, string>) {
  if (body === undefined || body === null) return undefined;
  if (body instanceof Blob || isFormData(body) || typeof body === "string" || body instanceof URLSearchParams) return body;
  if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
  return JSON.stringify(body);
}

async function readBlobWithProgress(response: Response, onProgress?: (progress: UploadProgress) => void) {
  const totalValue = response.headers.get("content-length");
  const total = totalValue ? Number(totalValue) : undefined;
  const knownTotal = total && Number.isFinite(total) && total > 0 ? total : undefined;
  if (!response.body) {
    const blob = await response.blob();
    onProgress?.(toProgress(blob.size, knownTotal ?? blob.size));
    return blob;
  }

  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let loaded = 0;
  onProgress?.(toProgress(0, knownTotal));

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value as BlobPart);
    loaded += value.byteLength;
    onProgress?.(toProgress(loaded, knownTotal));
  }

  const blob = new Blob(chunks);
  onProgress?.(toProgress(blob.size, knownTotal ?? blob.size));
  return blob;
}

async function fetchRequest<T = unknown>(request: RuntimeHttpRequest): Promise<RuntimeHttpResponse<T>> {
  const controller = new AbortController();
  const timeoutMs = request.timeoutMs ?? 20_000;
  const timeout = timeoutMs > 0 ? window.setTimeout(() => controller.abort(), timeoutMs) : undefined;
  const abortFromCaller = () => controller.abort();
  request.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const headers = { ...(request.headers ?? {}) };
  const body = normalizeBody(request.body, headers);
  const requestUrl = buildUrl(request.url, request.query);

  try {
    const fetcher = isTauri() ? (await import("@tauri-apps/plugin-http")).fetch : window.fetch.bind(window);
    const response = await fetcher(requestUrl, {
      method: request.method,
      headers,
      body,
      signal: controller.signal,
      credentials: "include",
    });

    const responseType = request.responseType ?? "json";
    let data: unknown;
    if (responseType === "blob") {
      data = await readBlobWithProgress(response, request.onDownloadProgress);
    } else if (responseType === "text") {
      data = await response.text();
    } else {
      const text = await response.text();
      data = text ? JSON.parse(text) : null;
    }

    return {
      status: response.status,
      headers: response.headers,
      data: data as T,
    };
  } finally {
    request.signal?.removeEventListener("abort", abortFromCaller);
    if (timeout) window.clearTimeout(timeout);
  }
}

function createBrowserWebSocket(url: string): RuntimeWebSocket {
  const socket = new WebSocket(url);
  const wrapper: RuntimeWebSocket = {
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    get readyState() {
      return socket.readyState;
    },
    send(data) {
      socket.send(data);
    },
    close() {
      socket.close();
    },
  };

  socket.onopen = () => wrapper.onopen?.();
  socket.onmessage = (event) => wrapper.onmessage?.({ data: event.data });
  socket.onerror = (event) => wrapper.onerror?.(event);
  socket.onclose = () => wrapper.onclose?.();

  return wrapper;
}

async function createTauriWebSocket(url: string): Promise<RuntimeWebSocket> {
  const { default: TauriWebSocket } = await import("@tauri-apps/plugin-websocket");
  let readyState = RUNTIME_SOCKET_CONNECTING;
  const socket = await TauriWebSocket.connect(url);
  let removeListener: (() => void) | null = null;

  const wrapper: RuntimeWebSocket = {
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    get readyState() {
      return readyState;
    },
    async send(data) {
      try {
        await socket.send(data);
      } catch (error) {
        wrapper.onerror?.(error);
      }
    },
    async close() {
      if (readyState === RUNTIME_SOCKET_CLOSING || readyState === RUNTIME_SOCKET_CLOSED) return;
      readyState = RUNTIME_SOCKET_CLOSING;
      removeListener?.();
      try {
        await socket.disconnect();
      } finally {
        readyState = RUNTIME_SOCKET_CLOSED;
        wrapper.onclose?.();
      }
    },
  };

  removeListener = socket.addListener((message) => {
    if (message.type === "Text") {
      wrapper.onmessage?.({ data: message.data });
      return;
    }
    if (message.type === "Binary") {
      wrapper.onmessage?.({ data: new Uint8Array(message.data) });
      return;
    }
    if (message.type === "Close") {
      readyState = RUNTIME_SOCKET_CLOSED;
      removeListener?.();
      wrapper.onclose?.();
    }
  });

  readyState = RUNTIME_SOCKET_OPEN;
  window.queueMicrotask(() => wrapper.onopen?.());
  return wrapper;
}

async function invokeTauriCommand<T = void>(command: string, args: Record<string, unknown>) {
  if (!isTauri()) throw new Error(i18nText("当前环境不是桌面端", "The current environment is not the desktop app"));
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

function getSystemNotificationPermission(): RuntimeSystemNotificationPermission {
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission;
}

async function requestSystemNotificationPermission(): Promise<RuntimeSystemNotificationPermission> {
  if (isTauri()) {
    try {
      const { isPermissionGranted, requestPermission } = await import("@tauri-apps/plugin-notification");
      if (await isPermissionGranted()) return "granted";
      const permission = await requestPermission();
      return permission === "granted" ? "granted" : permission === "denied" ? "denied" : "default";
    } catch (error) {
      console.warn("Tauri notification permission request failed.", error);
      return "unsupported";
    }
  }

  const permission = getSystemNotificationPermission();
  if (permission !== "default") return permission;

  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

async function notifySystem(notification: RuntimeSystemNotification): Promise<RuntimeSystemNotificationResult> {
  const permission = await requestSystemNotificationPermission();
  if (permission === "unsupported") return "unsupported";
  if (permission !== "granted") return "permission-denied";

  if (isTauri()) {
    try {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      sendNotification({
        title: notification.title,
        body: notification.body,
        silent: notification.silent,
      });
      return "shown";
    } catch (error) {
      console.warn("Tauri notification send failed.", error);
      return "unsupported";
    }
  }

  try {
    new Notification(notification.title, {
      body: notification.body,
      tag: notification.tag,
      silent: notification.silent,
    });
    return "shown";
  } catch {
    return "unsupported";
  }
}

function requireDesktopSsh(): never {
  throw new Error(i18nText("当前环境不是桌面端，无法使用应用内 SSH", "The current environment is not the desktop app, so in-app SSH is unavailable"));
}

export const browserRuntime: RuntimeTransport = {
  get isDesktop() {
    return runtimeKind === "desktop";
  },
  get isMobile() {
    return runtimeKind === "mobile";
  },
  get runtimeKind() {
    return runtimeKind;
  },
  get runLogChannel(): RuntimeLogChannel {
    return runtimeKind === "web" ? "web" : runtimeKind === "mobile" ? "mobile" : "tauri";
  },
  // Phase 1: all desktop-only capabilities are gated to desktop only.
  // Mobile opens these up in later phases (e.g. in-app SSH via russh on NDK).
  get supportsTray() {
    return runtimeKind === "desktop";
  },
  get supportsSystemTerminal() {
    return runtimeKind === "desktop";
  },
  get supportsInAppSsh() {
    return runtimeKind !== "web";
  },
  get supportsUpdater() {
    return runtimeKind === "desktop";
  },
  get supportsFileReveal() {
    return runtimeKind === "desktop";
  },
  storage: isTauri() ? tauriStorageAdapter : localStorageAdapter,
  request: fetchRequest,
  async createWebSocket(url) {
    return isTauri() ? createTauriWebSocket(url) : createBrowserWebSocket(url);
  },
  async copyText(text) {
    await window.navigator.clipboard.writeText(text);
  },
  requestSystemNotificationPermission,
  notifySystem,
  openExternal(url) {
    if (isTauri()) {
      void invokeTauriCommand("open_external_url", { url });
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  },
  openLocalPath(path) {
    if (runtimeKind !== "desktop") return Promise.resolve();
    return invokeTauriCommand("open_local_path", { path });
  },
  revealLocalPath(path) {
    if (runtimeKind !== "desktop") return Promise.resolve();
    return invokeTauriCommand("reveal_local_path", { path });
  },
  openSshSession(request) {
    return invokeTauriCommand<string>("open_ssh_session", { request });
  },
  writeSshSession(sessionId, data) {
    return invokeTauriCommand("ssh_write", { sessionId, data });
  },
  resizeSshSession(sessionId, cols, rows) {
    return invokeTauriCommand("ssh_resize", { sessionId, cols, rows });
  },
  closeSshSession(sessionId) {
    return invokeTauriCommand("ssh_close", { sessionId });
  },
  async onSshSessionEvent(sessionId, handler) {
    if (runtimeKind === "web") requireDesktopSsh();
    const { listen } = await import("@tauri-apps/api/event");
    return listen<SshSessionEvent>("ssh-session-event", (event) => {
      if (event.payload.sessionId !== sessionId) return;
      handler(event.payload);
    });
  },
  openSystemSshTerminal(request) {
    return invokeTauriCommand("open_system_ssh_terminal", { request });
  },
  openVscodeSsh(request) {
    return invokeTauriCommand("open_vscode_ssh", { request });
  },
  setDesktopCloseToTray(enabled) {
    if (runtimeKind !== "desktop") return Promise.resolve();
    return invokeTauriCommand("set_desktop_close_to_tray", { enabled });
  },
  setDesktopClosePrompt(enabled) {
    if (runtimeKind !== "desktop") return Promise.resolve();
    return invokeTauriCommand("set_desktop_close_prompt", { enabled });
  },
  cancelDesktopClosePrompt() {
    if (runtimeKind !== "desktop") return Promise.resolve();
    return invokeTauriCommand("cancel_desktop_close_prompt", {});
  },
  completeDesktopClosePrompt(action) {
    if (runtimeKind !== "desktop") return Promise.resolve();
    return invokeTauriCommand("complete_desktop_close_prompt", { action });
  },
  showDesktopMainWindow() {
    if (runtimeKind !== "desktop") return Promise.resolve();
    return invokeTauriCommand("show_desktop_main_window", {});
  },
  hideDesktopTrayMenu() {
    if (runtimeKind !== "desktop") return Promise.resolve();
    return invokeTauriCommand("hide_desktop_tray_menu", {});
  },
  runDueScheduledTasks() {
    if (runtimeKind !== "desktop") return Promise.resolve();
    return invokeTauriCommand("run_due_scheduled_tasks", {});
  },
  quitDesktopApp() {
    if (runtimeKind !== "desktop") return Promise.resolve();
    return invokeTauriCommand("quit_desktop_app", {});
  },
  async onDesktopCloseRequested(handler) {
    if (runtimeKind !== "desktop") return () => undefined;
    const { listen } = await import("@tauri-apps/api/event");
    return listen("desktop-close-requested", handler);
  },
  async onDesktopRunDueScheduledTasks(handler) {
    if (runtimeKind !== "desktop") return () => undefined;
    const { listen } = await import("@tauri-apps/api/event");
    return listen("desktop-run-due-scheduled-tasks", handler);
  },
};

export function toProgress(loaded: number, total?: number): UploadProgress {
  return {
    loaded,
    total,
    percent: total ? Math.round((loaded / total) * 100) : 0,
  };
}
