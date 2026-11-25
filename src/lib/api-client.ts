import { ApiError, type ApiEnvelope, type RuntimeTransport, type UnknownRecord } from "./types";
import { i18nText } from "./i18n-text";
import { assertTransportUrlAllowed, shouldEnforceSecureRemoteTransport } from "./transport-security";

export const DEFAULT_API_BASE_URL = "http://116.172.93.164:28080/api";
export const API_BASE_URL =
  ((import.meta as ImportMeta & { env?: { VITE_API_BASE_URL?: string } }).env?.VITE_API_BASE_URL || DEFAULT_API_BASE_URL);
export const TOKEN_STORAGE_KEY = "easy-console.token";
export const UNAUTHORIZED_EVENT = "easy-console:unauthorized";

type RequestOptions = {
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  responseType?: "json" | "blob" | "text";
  timeoutMs?: number;
  signal?: AbortSignal;
  auth?: boolean;
  raw?: boolean;
  onDownloadProgress?: (progress: { loaded: number; total?: number; percent: number }) => void;
  /** Internal: marks a request as already retried after token refresh to prevent infinite loops. */
  _retried?: boolean;
  /**
   * Internal: bypass the automatic refresh/retry path entirely. The token
   * refresh transport must use this: a 401 from the refresh endpoint would
   * otherwise enqueue behind the refresh cycle it is part of and deadlock.
   */
  _skipRefresh?: boolean;
};

type RetryQueueItem = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  request: () => Promise<unknown>;
};

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export function joinUrl(base: string, path: string) {
  return `${trimSlash(base)}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * A non-2xx response that carries no envelope. The message says what the status means and
 * keeps the number, so the raw fact stays visible. It never suggests a retry: after a 5xx
 * the request may still have gone through.
 */
export function httpStatusMessage(status: number) {
  if (status === 403) return i18nText(`没有权限执行此操作（HTTP ${status}）`, `No permission for this operation (HTTP ${status})`);
  if (status === 404) return i18nText(`服务端没有这个接口或资源（HTTP ${status}）`, `The server has no such endpoint or resource (HTTP ${status})`);
  if (status === 429) return i18nText(`请求过于频繁（HTTP ${status}）`, `Too many requests (HTTP ${status})`);
  if (status >= 500) return i18nText(`服务端出错（HTTP ${status}）`, `The server returned an error (HTTP ${status})`);
  return i18nText(`请求失败（HTTP ${status}）`, `Request failed (HTTP ${status})`);
}

export function getMessage(envelope: Partial<ApiEnvelope<unknown>>) {
  return envelope.msg || envelope.message || i18nText("请求失败", "Request failed");
}

export function isAuthError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 401 || error.code === 10000;
  }
  return false;
}

export function isNetworkError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.kind === "network";
  }
  return false;
}

/**
 * True when the server may have acted even though the client saw an error: a
 * network failure or timeout, a response the client could not read, or any
 * 5xx (a gateway can time out after the backend already ran the request).
 * A mutation that ends this way has an unknown outcome. Callers must have it
 * verified before replaying, never offer a blind retry: replaying a create
 * can start a second billed instance.
 */
export function isOutcomeUnknown(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.kind === "network" || error.kind === "parse") return true;
  return error.kind === "http" && typeof error.status === "number" && error.status >= 500;
}

/**
 * Parse a `json` response body. Only a 2xx body has to be JSON. A non-2xx body
 * that is not JSON (an nginx HTML 502 page, say) is kept as text so the client
 * still maps the status code, instead of the transport throwing a SyntaxError
 * that reads like a network failure. A 2xx body that is not JSON is a parse
 * error that keeps the status: the request reached the server and may have
 * taken effect.
 */
export function parseJsonResponseBody(text: string, status: number): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    if (status < 200 || status >= 300) return text;
    throw new ApiError(i18nText("响应格式无法识别", "Response format is not recognized"), { kind: "parse", status });
  }
}

/**
 * Thrown by a token refresh handler when the active session changed while the
 * refresh was in flight (e.g. the user switched accounts). The queued requests
 * belong to the previous session: they are released with this error, no
 * unauthorized event is emitted, and the new session stays intact.
 */
export class SessionChangedError extends Error {
  constructor() {
    super(i18nText("刷新期间账号已切换，已丢弃本次刷新结果", "The account changed while the token was refreshing"));
    this.name = "SessionChangedError";
  }
}

export function unwrapEnvelope<T>(payload: unknown): T {
  if (!payload || typeof payload !== "object" || !("code" in payload)) {
    throw new ApiError(i18nText("响应格式无法识别", "Response format is not recognized"), { kind: "parse" });
  }

  const envelope = payload as ApiEnvelope<T>;
  if (envelope.code !== 0) {
    if (envelope.code === 10000) emitUnauthorized();
    throw new ApiError(getMessage(envelope), { code: envelope.code, kind: "business" });
  }

  return envelope.data;
}

function emitUnauthorized() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  }
}

export function extractToken(data: unknown): string | null {
  if (typeof data === "string") return data || null;
  if (!data || typeof data !== "object") return null;
  const record = data as UnknownRecord;
  return String(record.token ?? record.access ?? record.access_token ?? record.Authorization ?? "") || null;
}

export function normalizeToken(token: string) {
  return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

export class ApiClient {
  private token: string | null = null;
  private refreshTokenHandler: ((token: string) => Promise<string | null>) | null = null;
  private refreshing: Promise<string | null> | null = null;
  private retryQueue: RetryQueueItem[] = [];

  constructor(
    private readonly runtime: RuntimeTransport,
    private baseUrl = API_BASE_URL,
  ) {}

  setBaseUrl(baseUrl: string) {
    assertTransportUrlAllowed(baseUrl, { enforceSecureRemote: shouldEnforceSecureRemoteTransport() });
    this.baseUrl = baseUrl;
  }

  getBaseUrl() {
    return this.baseUrl;
  }

  setToken(token: string | null) {
    this.token = token;
  }

  getToken() {
    return this.token;
  }

  setRefreshTokenHandler(handler: ((token: string) => Promise<string | null>) | null) {
    this.refreshTokenHandler = handler;
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    assertTransportUrlAllowed(this.baseUrl, { enforceSecureRemote: shouldEnforceSecureRemoteTransport() });
    const headers = { ...(options.headers ?? {}) };
    if (options.auth !== false && this.token) {
      headers.Authorization = this.token;
    }

    let response;
    try {
      response = await this.runtime.request<unknown>({
        method,
        url: joinUrl(this.baseUrl, path),
        query: options.query,
        body: options.body,
        headers,
        responseType: options.responseType,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        onDownloadProgress: options.onDownloadProgress,
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(error instanceof Error ? error.message : i18nText("网络请求失败", "Network request failed"), { kind: "network" });
    }

    if (response.status === 401) {
      // Any method may retry once after a successful token refresh (single-flight via queue).
      const bypassRefresh = options._skipRefresh === true;
      if (this.refreshTokenHandler && !options._retried && !bypassRefresh) {
        return this.queueForRetry<T>(method, path, { ...options, _retried: true });
      }
      // The refresh transport itself must not emit unauthorized: the refresh
      // orchestration in refreshAndRetry owns that event and the queue teardown.
      if (!bypassRefresh) emitUnauthorized();
      throw new ApiError(i18nText("登录已过期，请重新登录", "Sign-in expired. Please sign in again."), { status: 401, code: 10000, kind: "http" });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ApiError(httpStatusMessage(response.status), { status: response.status, kind: "http" });
    }

    if (options.raw || options.responseType === "blob" || options.responseType === "text") {
      return response.data as T;
    }

    return unwrapEnvelope<T>(response.data);
  }

  private queueForRetry<T>(method: string, path: string, options: RequestOptions): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.retryQueue.push({
        resolve: resolve as (value: unknown) => void,
        reject,
        request: () => this.request<T>(method, path, options),
      });
      if (!this.refreshing) {
        this.startRefreshCycle();
      }
    });
  }

  private startRefreshCycle() {
    this.refreshing = this.refreshAndRetry().finally(() => {
      this.refreshing = null;
      // Requests that hit 401 while the previous cycle was replaying must not
      // wait forever; run another cycle if anything is still queued.
      if (this.retryQueue.length > 0) {
        this.startRefreshCycle();
      }
    });
  }

  private async refreshAndRetry(): Promise<string | null> {
    try {
      const currentToken = this.token;
      if (!currentToken || !this.refreshTokenHandler) {
        throw new Error("No token or refresh handler available");
      }
      const newToken = await this.refreshTokenHandler(currentToken);
      if (!newToken) {
        throw new Error("Token refresh returned null");
      }
      this.setToken(newToken);
      // Retry all queued requests in parallel.
      const queue = this.retryQueue.splice(0);
      await Promise.all(
        queue.map(async (item) => {
          try {
            const result = await item.request();
            item.resolve(result);
          } catch (error) {
            item.reject(error);
          }
        }),
      );
      return newToken;
    } catch (error) {
      // The session can no longer be refreshed: release every queued request.
      // Definitive refresh failures (refresh endpoint rejected the token,
      // handler returned null) reject the queue as unauthorized and surface one
      // unauthorized event so the app logs out. Failures that prove nothing
      // about the token (network, unreadable response, 5xx) and session
      // changes (the account switched mid-refresh) release the queue with the
      // original error but keep the session: a gateway error is not a rejected
      // token, and the replacement session must not be logged out for
      // requests that belong to the previous one.
      const transient = isOutcomeUnknown(error) || error instanceof SessionChangedError;
      const queueError = transient
        ? error
        : new ApiError(i18nText("登录已过期，请重新登录", "Sign-in expired. Please sign in again."), {
            status: 401,
            code: 10000,
            kind: "http",
          });
      const queue = this.retryQueue.splice(0);
      queue.forEach((item) => item.reject(queueError));
      if (!transient) emitUnauthorized();
      return null;
    }
  }

  get<T>(path: string, options?: RequestOptions) {
    return this.request<T>("GET", path, options);
  }

  post<T>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>("POST", path, { ...options, body });
  }

  put<T>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>("PUT", path, { ...options, body });
  }

  patch<T>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>("PATCH", path, { ...options, body });
  }

  delete<T>(path: string, options?: RequestOptions) {
    return this.request<T>("DELETE", path, options);
  }
}
