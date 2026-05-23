import { isTauri } from "@tauri-apps/api/core";

import type {
  RuntimeHttpRequest,
  RuntimeHttpResponse,
  RuntimeStorage,
  RuntimeTransport,
  RuntimeWebSocket,
  UploadProgress,
} from "./types";

export const RUNTIME_SOCKET_OPEN = 1;
const RUNTIME_SOCKET_CONNECTING = 0;
const RUNTIME_SOCKET_CLOSING = 2;
const RUNTIME_SOCKET_CLOSED = 3;

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

async function fetchRequest<T = unknown>(request: RuntimeHttpRequest): Promise<RuntimeHttpResponse<T>> {
  const controller = new AbortController();
  const timeoutMs = request.timeoutMs ?? 20_000;
  const timeout = timeoutMs > 0 ? window.setTimeout(() => controller.abort(), timeoutMs) : undefined;
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
      data = await response.blob();
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

export const browserRuntime: RuntimeTransport = {
  storage: localStorageAdapter,
  request: fetchRequest,
  async createWebSocket(url) {
    return isTauri() ? createTauriWebSocket(url) : createBrowserWebSocket(url);
  },
};

export function toProgress(loaded: number, total?: number): UploadProgress {
  return {
    loaded,
    total,
    percent: total ? Math.round((loaded / total) * 100) : 0,
  };
}
