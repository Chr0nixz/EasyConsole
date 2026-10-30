import { isTauri } from "@tauri-apps/api/core";
import { getActiveAccountScope } from "./account-scope";

import { i18nText, type Locale } from "./i18n-text";
import { createLayeredSecureStorage } from "./secure-storage";
import type {
  KnownHostEntry,
  PortForwardStatus,
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
  SftpEntry,
  SftpProgress,
  SftpTransferOutcome,
  SshHistoryEntry,
  SshSessionEvent,
  UploadProgress,
  VscodeKeyRecord,
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
const taskSshSessions = new Map<string, { sessionId: string; scope: string }>();
const pendingGpuProbes = new Map<string, Promise<number[]>>();
type SshWriteQueue = {
  tail: Promise<void>;
  cancelled: Promise<never>;
  cancel(): void;
  closed: boolean;
};
const sshWriteQueues = new Map<string, SshWriteQueue>();
const closingSshSessions = new Set<string>();

function sshSessionClosedError() {
  return new Error(i18nText("SSH 会话已关闭", "The SSH session is closed"));
}

function clearSshSessionRequests(sessionId: string) {
  const queue = sshWriteQueues.get(sessionId);
  if (queue) {
    queue.closed = true;
    queue.cancel();
    sshWriteQueues.delete(sessionId);
  }
  pendingGpuProbes.delete(sessionId);
  for (const [key, entry] of taskSshSessions) {
    if (entry.sessionId === sessionId) taskSshSessions.delete(key);
  }
}

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

/**
 * Native storage operations the cached window adapter is built on. The real
 * bindings invoke Tauri commands; tests supply a shared fake backend to
 * simulate two windows against one store.
 */
export type NativeStorageBackend = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /**
   * Apply `next` (insert or remove when null) only when the stored value still
   * equals `expected`. On conflict, resolve `{ updated: false, current }` with
   * the authoritative value so the caller can retry without a second read.
   */
  compareAndSwap(
    key: string,
    expected: string | null,
    next: string | null,
    /** For fallback migration, a tombstone also counts as an existing record. */
    migrateIfMissing?: boolean,
  ): Promise<{ updated: boolean; current: string | null }>;
};

/** Payload of the native cross-window storage-change broadcast. */
export type StorageChangeBroadcast = { key: string; source: string };

export type CachedWindowStorageOptions = {
  backend: NativeStorageBackend;
  /** Subscribe to native storage-change broadcasts; returns an unlisten function. */
  subscribeChanges(handler: (event: StorageChangeBroadcast) => void): Promise<() => void>;
  /** This window's label; broadcasts originating here are self-writes. */
  selfLabel(): Promise<string>;
  /** Store used when native commands fail (and for one-time migration reads). */
  fallback: RuntimeStorage;
  /** Disable cache hits for stores also written by CLI/MCP without window broadcasts. */
  cacheReads?: boolean;
  /** Shared stores must fail a failed CAS instead of degrading to a blind write. */
  requireCompareAndSwap?: boolean;
};

/** Give up the CAS retry loop after this many cross-window conflicts. */
export const MAX_STORAGE_CAS_ATTEMPTS = 8;

/**
 * Window-local storage adapter over a native backend.
 *
 * Reduces IPC round-trips via an in-memory cache. Correctness across windows:
 * every native write broadcasts a change event, and foreign broadcasts
 * invalidate the matching cache entry (self-writes are ignored — the cache was
 * already updated synchronously). A per-key epoch counter keeps a late,
 * stale `get` response from repopulating the cache after an invalidation.
 *
 * `update` performs a compare-and-swap loop so two windows running
 * read-modify-write on the same key cannot silently drop each other's changes:
 * the native CAS runs under the global storage lock and the losing window
 * retries its transform against the fresh value.
 */
export function createCachedWindowStorage(options: CachedWindowStorageOptions): RuntimeStorage {
  const cache = new Map<string, string | null>();
  const epochs = new Map<string, number>();
  let subscription: Promise<void> | null = null;

  // Lazy so merely importing the module never touches IPC; the first storage
  // operation registers the listener. Fire-and-forget on purpose: storage must
  // never block on the subscription, and a broadcast racing the registration
  // only costs one stale cache read until the next invalidation.
  const ensureSubscription = () => {
    if (subscription) return;
    subscription = (async () => {
      let selfLabel: string | null = null;
      try {
        selfLabel = await options.selfLabel();
      } catch (error) {
        // Without our own label every broadcast counts as foreign: correctness
        // (dropping a stale cache entry) over avoiding churn.
        console.warn("Failed to resolve this window's label for storage invalidation.", error);
      }
      try {
        await options.subscribeChanges((event) => {
          if (selfLabel !== null && event.source === selfLabel) return;
          epochs.set(event.key, (epochs.get(event.key) ?? 0) + 1);
          cache.delete(event.key);
        });
      } catch (error) {
        console.warn("Failed to subscribe to storage change broadcasts.", error);
      }
    })();
  };

  const get = async (key: string): Promise<string | null> => {
    ensureSubscription();
    if (options.cacheReads !== false && cache.has(key)) {
      const cached = cache.get(key) ?? null;
      if (cached !== null) return cached;
      // Cached null may be from a prior IPC miss while fallback still holds data.
    }
    const epochAtStart = epochs.get(key) ?? 0;
    const cacheIfUnchanged = (value: string | null) => {
      if ((epochs.get(key) ?? 0) === epochAtStart) cache.set(key, value);
    };
    try {
      const value = await options.backend.get(key);
      if (value !== null && value !== undefined) {
        cacheIfUnchanged(value);
        return value;
      }
      // Native miss — check the fallback store and migrate any copy back to native.
      const fallback = await options.fallback.get(key);
      if (fallback !== null) {
        try {
          if (options.requireCompareAndSwap) {
            const migration = await options.backend.compareAndSwap(key, null, fallback, true);
            if (!migration.updated) {
              await options.fallback.remove(key).catch(() => undefined);
              cacheIfUnchanged(migration.current);
              return migration.current;
            }
          } else {
            await options.backend.set(key, fallback);
          }
          await options.fallback.remove(key);
        } catch (migrateError) {
          console.warn("Tauri storage migrate-from-fallback failed.", migrateError);
        }
        cacheIfUnchanged(fallback);
        return fallback;
      }
      cacheIfUnchanged(null);
      return null;
    } catch (error) {
      console.warn("Tauri storage get failed, falling back to localStorage.", error);
      return options.fallback.get(key);
    }
  };

  const set = async (key: string, value: string): Promise<void> => {
    ensureSubscription();
    cache.set(key, value);
    try {
      await options.backend.set(key, value);
      // Clear stale fallback copy after successful native write.
      await options.fallback.remove(key).catch(() => undefined);
    } catch (error) {
      console.warn("Tauri storage set failed, falling back to localStorage.", error);
      await options.fallback.set(key, value);
    }
  };

  const remove = async (key: string): Promise<void> => {
    ensureSubscription();
    // Tombstone in cache so a later get does not revive stale fallback before native delete lands.
    cache.set(key, null);
    try {
      await options.backend.remove(key);
      await options.fallback.remove(key);
    } catch (error) {
      console.warn("Tauri storage remove failed, falling back to localStorage.", error);
      await options.fallback.remove(key);
    }
  };

  const update = async (
    key: string,
    updater: (current: string | null) => string | null | Promise<string | null>,
  ): Promise<string | null> => {
    ensureSubscription();
    let expected = await get(key);
    for (let attempt = 0; attempt < MAX_STORAGE_CAS_ATTEMPTS; attempt += 1) {
      const next = await updater(expected);
      if (next === expected) return next; // unchanged: skip the write entirely
      let outcome: { updated: boolean; current: string | null };
      const epochAtCasStart = epochs.get(key) ?? 0;
      try {
        outcome = await options.backend.compareAndSwap(key, expected, next);
      } catch (error) {
        if (options.requireCompareAndSwap) throw error;
        // Native CAS unavailable (stale shell build / IPC failure): degrade to
        // the previous plain write rather than failing the whole operation.
        console.warn("Tauri storage compare-and-swap failed; writing without cross-window protection.", error);
        if (next === null) {
          await remove(key);
          return null;
        }
        await set(key, next);
        return next;
      }
      if (outcome.updated) {
        // A foreign broadcast may have landed between our CAS commit and this
        // line; only cache when nothing invalidated the key in between.
        if ((epochs.get(key) ?? 0) === epochAtCasStart) cache.set(key, next);
        else cache.delete(key);
        await options.fallback.remove(key).catch(() => undefined);
        return next;
      }
      // Another window won the race; re-apply the transform on the fresh value.
      expected = outcome.current;
    }
    throw new Error(
      i18nText(
        `本地数据保存连续 ${MAX_STORAGE_CAS_ATTEMPTS} 次与其他窗口冲突：${key}`,
        `Local data for "${key}" could not be saved after ${MAX_STORAGE_CAS_ATTEMPTS} cross-window conflicts`,
      ),
    );
  };

  return { get, set, remove, update };
}

const STORAGE_CHANGED_EVENT = "runtime-storage-changed";

const tauriStorageAdapter: RuntimeStorage = createCachedWindowStorage({
  backend: {
    get: (key) => invokeTauriCommand<string | null>("runtime_storage_get", { key }),
    set: (key, value) => invokeTauriCommand("runtime_storage_set", { key, value }),
    remove: (key) => invokeTauriCommand("runtime_storage_remove", { key }),
    compareAndSwap: (key, expected, next, migrateIfMissing) =>
      invokeTauriCommand<{ updated: boolean; current: string | null }>("runtime_storage_compare_and_swap", {
        key,
        expected,
        next,
        migrateIfMissing,
      }),
  },
  subscribeChanges: async (handler) => {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<StorageChangeBroadcast>(STORAGE_CHANGED_EVENT, (event) => handler(event.payload));
  },
  selfLabel: async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow().label;
  },
  fallback: localStorageAdapter,
  // Node sidecars share the files but do not emit Tauri window broadcasts.
  cacheReads: false,
  requireCompareAndSwap: true,
});

// Secure storage uses the OS keychain on desktop (macOS Keychain, Windows
// Credential Manager, Linux Secret Service) and falls back to tauriStorage when
// keychain is unavailable or rejects the value (Windows blob size limit).
// get() must consult the fallback when keychain returns null — not only on
// thrown errors — or a successful fallback write is lost on the next read.
const tauriKeychainAdapter: RuntimeStorage = {
  async get(key) {
    return invokeTauriCommand<string | null>("keychain_get", { key });
  },
  async set(key, value) {
    await invokeTauriCommand("keychain_set", { key, value });
  },
  async remove(key) {
    await invokeTauriCommand("keychain_remove", { key });
  },
};

const tauriSecureStorageAdapter: RuntimeStorage = createLayeredSecureStorage(
  tauriKeychainAdapter,
  tauriStorageAdapter,
);

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

/** Minimum gap between download progress callbacks, in ms. */
const PROGRESS_REPORT_INTERVAL_MS = 200;

function normalizeBody(body: unknown, headers: Record<string, string>) {
  if (body === undefined || body === null) return undefined;
  if (body instanceof Blob || isFormData(body) || typeof body === "string" || body instanceof URLSearchParams) return body;
  if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
  return JSON.stringify(body);
}

async function readBlobWithProgress(
  response: Response,
  onProgress?: (progress: UploadProgress) => void,
  onChunk?: () => void,
) {
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

  // Network chunks arrive every 16-64 KB. Reporting each one drives a global
  // download-queue Context update, which re-renders the whole shell and the
  // current page -- tens of thousands of renders for a 1 GB file. Report on a
  // time/percent threshold instead; the final value is always emitted below.
  let lastReportAt = 0;
  let lastReportedPercent = -1;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value as BlobPart);
    loaded += value.byteLength;
    // Progress proves the connection is alive: reset the idle timeout window.
    onChunk?.();

    if (onProgress) {
      const now = Date.now();
      const percent = knownTotal ? Math.floor((loaded / knownTotal) * 100) : -1;
      if (now - lastReportAt >= PROGRESS_REPORT_INTERVAL_MS || percent !== lastReportedPercent) {
        lastReportAt = now;
        lastReportedPercent = percent;
        onProgress(toProgress(loaded, knownTotal));
      }
    }
  }

  const blob = new Blob(chunks);
  onProgress?.(toProgress(blob.size, knownTotal ?? blob.size));
  return blob;
}

async function fetchRequest<T = unknown>(request: RuntimeHttpRequest): Promise<RuntimeHttpResponse<T>> {
  const controller = new AbortController();
  const timeoutMs = request.timeoutMs ?? 20_000;
  // JSON/text requests keep one overall timeout. Blob (download) requests
  // cannot: a large or slow body legitimately takes longer than the timeout
  // budget. Once headers arrive, the same timer is re-armed per received
  // chunk, turning it into an idle timeout that only fires when the
  // connection stops delivering data. `timeoutMs <= 0` disables it entirely.
  let timeout: number | undefined;
  const armTimeout = () => {
    if (timeoutMs <= 0) return;
    if (timeout !== undefined) window.clearTimeout(timeout);
    timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  };
  const disarmTimeout = () => {
    if (timeout !== undefined) window.clearTimeout(timeout);
    timeout = undefined;
  };
  armTimeout();
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
      // Headers arrived: restart the timer as the first idle window.
      armTimeout();
      data = await readBlobWithProgress(response, request.onDownloadProgress, armTimeout);
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
    disarmTimeout();
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

/**
 * Push the interface language to the native side. Rust produces a number of
 * user-facing strings itself (SSH/SFTP errors, session events, Android installer
 * messages) and has no other way to learn the selected locale. On the web this
 * is a no-op.
 */
export async function setNativeLocale(locale: Locale): Promise<void> {
  if (!isTauri()) return;
  try {
    await invokeTauriCommand("set_locale", { locale });
  } catch (error) {
    console.warn("Failed to sync the native locale.", error);
  }
}

async function getSystemNotificationPermission(): Promise<RuntimeSystemNotificationPermission> {
  if (isTauri()) {
    try {
      const { isPermissionGranted } = await import("@tauri-apps/plugin-notification");
      return (await isPermissionGranted()) ? "granted" : "default";
    } catch (error) {
      console.warn("Tauri notification permission lookup failed.", error);
      return "unsupported";
    }
  }

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

  const permission = await getSystemNotificationPermission();
  if (permission !== "default") return permission;

  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

async function notifySystem(notification: RuntimeSystemNotification): Promise<RuntimeSystemNotificationResult> {
  // System notification permission must only be requested from an explicit
  // Settings action. Background task polling is allowed to inspect it, never
  // to surface a browser or operating-system prompt.
  const permission = await getSystemNotificationPermission();
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

const SSH_EARLY_EVENT_LIMIT = 64;

type SshSessionEventHandler = (event: SshSessionEvent) => void;

const sshSessionHandlers = new Map<string, SshSessionEventHandler>();
const sshEarlyEventBuffer = new Map<string, SshSessionEvent[]>();
let sshGlobalListenPromise: Promise<void> | null = null;

function clearSshSessionEvents(sessionId: string) {
  sshSessionHandlers.delete(sessionId);
  sshEarlyEventBuffer.delete(sessionId);
}

function bufferSshSessionEvent(event: SshSessionEvent) {
  const queued = sshEarlyEventBuffer.get(event.sessionId) ?? [];
  if (queued.length >= SSH_EARLY_EVENT_LIMIT) {
    queued.shift();
  }
  queued.push(event);
  sshEarlyEventBuffer.set(event.sessionId, queued);
}

function dispatchSshSessionEvent(event: SshSessionEvent) {
  if (event.kind === "closed") clearSshSessionRequests(event.sessionId);
  const handler = sshSessionHandlers.get(event.sessionId);
  if (handler) {
    handler(event);
    return;
  }
  bufferSshSessionEvent(event);
}

/**
 * Subscribes to the native `ssh-session-event` stream. The native side emits
 * with `emit_to(this window's label)`, so the listener must register with the
 * same target: the JS default target (`kind: "Any"`) still matches every emit,
 * which is exactly the cross-window terminal-output exposure the targeting
 * exists to close.
 */
async function listenSshSessionEvent(
  handler: (event: { payload: SshSessionEvent }) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return listen<SshSessionEvent>("ssh-session-event", handler, {
    target: { kind: "WebviewWindow", label: getCurrentWindow().label },
  });
}

async function ensureGlobalSshListen() {
  if (runtimeKind === "web") return;
  if (sshGlobalListenPromise) {
    await sshGlobalListenPromise;
    return;
  }
  sshGlobalListenPromise = (async () => {
    await listenSshSessionEvent((event) => {
      dispatchSshSessionEvent(event.payload);
    });
  })();
  try {
    await sshGlobalListenPromise;
  } catch (error) {
    sshGlobalListenPromise = null;
    throw error;
  }
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
  get supportsSshPopOut() {
    return runtimeKind === "desktop";
  },
  get supportsUpdater() {
    return runtimeKind === "desktop" || runtimeKind === "mobile";
  },
  get supportsFileReveal() {
    return runtimeKind === "desktop";
  },
  get supportsAutostart() {
    return runtimeKind === "desktop";
  },
  get isApplePlatform() {
    return typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
  },
  storage: isTauri() ? tauriStorageAdapter : localStorageAdapter,
  secureStorage: isTauri() ? tauriSecureStorageAdapter : localStorageAdapter,
  request: fetchRequest,
  async createWebSocket(url) {
    return isTauri() ? createTauriWebSocket(url) : createBrowserWebSocket(url);
  },
  async copyText(text) {
    await window.navigator.clipboard.writeText(text);
  },
  async readClipboardText() {
    return window.navigator.clipboard.readText();
  },
  getSystemNotificationPermission,
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
  revealSftpLocalPath(sessionId, path) {
    if (runtimeKind !== "desktop") return Promise.resolve();
    return invokeTauriCommand("reveal_sftp_local_path", { sessionId, path });
  },
  async openSshSession(request) {
    await ensureGlobalSshListen();
    const scope = getActiveAccountScope().key;
    const sessionId = await invokeTauriCommand<string>("open_ssh_session", { request });
    if (request.taskId) taskSshSessions.set(request.taskId, { sessionId, scope });
    return sessionId;
  },
  async readTaskGpuUtilization(taskId) {
    const session = taskSshSessions.get(taskId);
    if (runtimeKind !== "desktop" || !session || session.scope !== getActiveAccountScope().key) return null;
    const pending = pendingGpuProbes.get(session.sessionId);
    if (pending) return pending;
    const probe = invokeTauriCommand<number[]>("ssh_gpu_utilization", { sessionId: session.sessionId }).finally(() => {
      if (pendingGpuProbes.get(session.sessionId) === probe) pendingGpuProbes.delete(session.sessionId);
    });
    pendingGpuProbes.set(session.sessionId, probe);
    return probe;
  },
  writeSshSession(sessionId, data) {
    if (closingSshSessions.has(sessionId)) return Promise.reject(sshSessionClosedError());
    let queue = sshWriteQueues.get(sessionId);
    if (!queue) {
      let cancel!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        cancel = () => reject(sshSessionClosedError());
      });
      queue = { tail: Promise.resolve(), cancelled, cancel, closed: false };
      sshWriteQueues.set(sessionId, queue);
    }
    const activeQueue = queue;
    const write = Promise.race([
      activeQueue.tail.then(() => {
        if (activeQueue.closed) throw sshSessionClosedError();
        return invokeTauriCommand("ssh_write", { sessionId, data });
      }),
      activeQueue.cancelled,
    ]);
    const tail = write.then(() => undefined, () => undefined);
    activeQueue.tail = tail;
    void tail.then(() => {
      if (sshWriteQueues.get(sessionId) === activeQueue && activeQueue.tail === tail) {
        sshWriteQueues.delete(sessionId);
      }
    });
    return write;
  },
  resizeSshSession(sessionId, cols, rows) {
    return invokeTauriCommand("ssh_resize", { sessionId, cols, rows });
  },
  acknowledgeSshOutput(sessionId, sequence) {
    return invokeTauriCommand("ssh_ack_output", { sessionId, sequence });
  },
  async closeSshSession(sessionId) {
    closingSshSessions.add(sessionId);
    clearSshSessionRequests(sessionId);
    try {
      await invokeTauriCommand("ssh_close", { sessionId });
    } finally {
      closingSshSessions.delete(sessionId);
      clearSshSessionEvents(sessionId);
    }
  },
  async onSshSessionEvent(sessionId, handler) {
    if (runtimeKind === "web") requireDesktopSsh();
    await ensureGlobalSshListen();
    sshSessionHandlers.set(sessionId, handler);
    const buffered = sshEarlyEventBuffer.get(sessionId) ?? [];
    sshEarlyEventBuffer.delete(sessionId);
    for (const event of buffered) {
      handler(event);
    }
    return () => {
      if (sshSessionHandlers.get(sessionId) === handler) {
        clearSshSessionEvents(sessionId);
      }
    };
  },
  async listKnownHosts() {
    if (runtimeKind === "web") return [];
    return invokeTauriCommand<KnownHostEntry[]>("list_known_hosts", {});
  },
  async removeKnownHost(hostPort) {
    if (runtimeKind === "web") return;
    await invokeTauriCommand("remove_known_host", { hostPort });
  },
  async clearKnownHosts() {
    if (runtimeKind === "web") return;
    await invokeTauriCommand("clear_known_hosts", {});
  },
  async confirmKnownHost(promptId, accept, confirmChangedKey) {
    if (runtimeKind === "web") return;
    await invokeTauriCommand("confirm_known_host", { promptId, accept, confirmChangedKey });
  },
  openSystemSshTerminal(request) {
    return invokeTauriCommand("open_system_ssh_terminal", { request });
  },
  openVscodeSsh(request) {
    return invokeTauriCommand("open_vscode_ssh", { request });
  },
  listVscodeSshKeys() {
    if (runtimeKind !== "desktop") return Promise.resolve([]);
    return invokeTauriCommand<VscodeKeyRecord[]>("list_vscode_ssh_keys", {});
  },
  hasLegacyVscodeKey() {
    if (runtimeKind !== "desktop") return Promise.resolve(false);
    return invokeTauriCommand<boolean>("has_legacy_vscode_ssh_key", {});
  },
  cleanupLegacyVscodeKey() {
    if (runtimeKind !== "desktop") {
      return Promise.reject(
        new Error(i18nText("当前环境不支持 VS Code Remote-SSH", "VS Code Remote-SSH is not supported in this environment")),
      );
    }
    return invokeTauriCommand("cleanup_legacy_vscode_ssh_key", {});
  },
  revokeVscodeSsh(request, removeRemote) {
    if (runtimeKind !== "desktop") {
      return Promise.reject(
        new Error(i18nText("当前环境不支持 VS Code Remote-SSH", "VS Code Remote-SSH is not supported in this environment")),
      );
    }
    return invokeTauriCommand("revoke_vscode_ssh", { request, removeRemote });
  },
  openSshWindow(request, preferences) {
    if (runtimeKind !== "desktop") {
      return Promise.reject(
        new Error(
          i18nText("当前环境不支持弹出独立窗口", "Popping out to a standalone window is not supported in this environment"),
        ),
      );
    }
    return invokeTauriCommand("open_ssh_window", { request, preferences });
  },
  sftpRegisterLocalRoot(sessionId, rootPath) {
    if (runtimeKind === "web") return Promise.resolve();
    return invokeTauriCommand("sftp_register_local_root", { sessionId, rootPath });
  },
  sftpList(sessionId, path) {
    if (runtimeKind === "web") return Promise.reject(new Error(i18nText("当前环境不支持 SFTP", "SFTP is not supported in this environment")));
    return invokeTauriCommand<SftpEntry[]>("sftp_list", { sessionId, path });
  },
  sftpUpload(sessionId, localPath, remotePath) {
    if (runtimeKind === "web") return Promise.reject(new Error(i18nText("当前环境不支持 SFTP", "SFTP is not supported in this environment")));
    return invokeTauriCommand<SftpTransferOutcome>("sftp_upload", { sessionId, localPath, remotePath });
  },
  sftpDownload(sessionId, remotePath, localPath) {
    if (runtimeKind === "web") return Promise.reject(new Error(i18nText("当前环境不支持 SFTP", "SFTP is not supported in this environment")));
    return invokeTauriCommand<SftpTransferOutcome>("sftp_download", { sessionId, remotePath, localPath });
  },
  sftpDelete(sessionId, path) {
    if (runtimeKind === "web") return Promise.reject(new Error(i18nText("当前环境不支持 SFTP", "SFTP is not supported in this environment")));
    return invokeTauriCommand("sftp_delete", { sessionId, path });
  },
  sftpRename(sessionId, oldPath, newPath) {
    if (runtimeKind === "web") return Promise.reject(new Error(i18nText("当前环境不支持 SFTP", "SFTP is not supported in this environment")));
    return invokeTauriCommand("sftp_rename", { sessionId, oldPath, newPath });
  },
  sftpMkdir(sessionId, path) {
    if (runtimeKind === "web") return Promise.reject(new Error(i18nText("当前环境不支持 SFTP", "SFTP is not supported in this environment")));
    return invokeTauriCommand("sftp_mkdir", { sessionId, path });
  },
  sftpCancel(sessionId, transferId) {
    if (runtimeKind === "web") return Promise.reject(new Error(i18nText("当前环境不支持 SFTP", "SFTP is not supported in this environment")));
    return invokeTauriCommand("sftp_cancel", { sessionId, transferId });
  },
  async onSftpProgress(sessionId, handler) {
    if (runtimeKind === "web") requireDesktopSsh();
    return listenSshSessionEvent((event) => {
      if (event.payload.sessionId !== sessionId || event.payload.kind !== "sftp-progress") return;
      try {
        const progress = JSON.parse(event.payload.data ?? "{}") as SftpProgress;
        handler(progress);
      } catch {
        // ignore malformed progress events
      }
    });
  },
  startPortForward(sessionId, rule) {
    if (runtimeKind === "web") return Promise.reject(new Error(i18nText("当前环境不支持端口转发", "Port forwarding is not supported in this environment")));
    return invokeTauriCommand<number>("ssh_start_port_forward", { sessionId, rule });
  },
  stopPortForward(sessionId, ruleId) {
    if (runtimeKind === "web") return Promise.reject(new Error(i18nText("当前环境不支持端口转发", "Port forwarding is not supported in this environment")));
    return invokeTauriCommand("ssh_stop_port_forward", { sessionId, ruleId });
  },
  async onPortForwardStatus(sessionId, handler) {
    if (runtimeKind === "web") requireDesktopSsh();
    return listenSshSessionEvent((event) => {
      if (event.payload.sessionId !== sessionId || event.payload.kind !== "port-forward-status") return;
      try {
        const status = JSON.parse(event.payload.data ?? "{}") as PortForwardStatus;
        handler(status);
      } catch {
        // ignore malformed status events
      }
    });
  },
  async listSshHistory() {
    if (runtimeKind === "web") {
      try {
        const raw = window.localStorage.getItem("easy-console-ssh-history");
        return raw ? (JSON.parse(raw) as SshHistoryEntry[]) : [];
      } catch {
        return [];
      }
    }
    return invokeTauriCommand<SshHistoryEntry[]>("list_ssh_history", {});
  },
  async addSshHistory(entry, limit = 20) {
    if (runtimeKind === "web") {
      try {
        const raw = window.localStorage.getItem("easy-console-ssh-history");
        const existing = raw ? (JSON.parse(raw) as SshHistoryEntry[]) : [];
        const filtered = existing.filter(
          (h) => !(h.host === entry.host && h.port === entry.port && h.username === entry.username),
        );
        const newEntry: SshHistoryEntry = {
          ...entry,
          id: `hist-${Date.now()}`,
          connectedAt: Date.now(),
        };
        filtered.unshift(newEntry);
        const trimmed = filtered.slice(0, Math.max(1, limit));
        window.localStorage.setItem("easy-console-ssh-history", JSON.stringify(trimmed));
      } catch {
        // ignore storage errors
      }
      return;
    }
    await invokeTauriCommand("add_ssh_history", { ...entry, limit });
  },
  async clearSshHistory() {
    if (runtimeKind === "web") {
      window.localStorage.removeItem("easy-console-ssh-history");
      return;
    }
    await invokeTauriCommand("clear_ssh_history", {});
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
  getDesktopAutostart() {
    if (runtimeKind !== "desktop") return Promise.resolve(false);
    return invokeTauriCommand<boolean>("plugin:autostart|is_enabled", {});
  },
  setDesktopAutostart(enabled) {
    if (runtimeKind !== "desktop") return Promise.resolve();
    return invokeTauriCommand(enabled ? "plugin:autostart|enable" : "plugin:autostart|disable", {});
  },
  desktopScheduledWake(enabled) {
    if (runtimeKind !== "desktop") return Promise.resolve(null);
    return invokeTauriCommand<boolean | null>("desktop_scheduled_wake", { enabled: enabled ?? null });
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
  async setNativeTheme(theme) {
    if (runtimeKind !== "desktop") return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setTheme(theme);
    } catch (error) {
      // Title bar theming is cosmetic; the webview theme already applied.
      console.warn("Failed to set native window theme.", error);
    }
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
  async onDeepLink(handler: (urls: string[]) => void) {
    if (runtimeKind !== "desktop") return () => undefined;
    const { listen } = await import("@tauri-apps/api/event");
    type DeepLinkPayload = { urls: string[] } | string[];
    return listen<DeepLinkPayload>("deep-link://new-url", (event) => {
      const payload = event.payload;
      const urls = Array.isArray(payload) ? payload : payload?.urls ?? [];
      if (urls.length > 0) handler(urls);
    });
  },
};

export function toProgress(loaded: number, total?: number): UploadProgress {
  return {
    loaded,
    total,
    percent: total ? Math.round((loaded / total) * 100) : 0,
  };
}
