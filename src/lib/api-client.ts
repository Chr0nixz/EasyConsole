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
      if (this.refreshTokenHandler && !options._retried) {
        return this.queueForRetry<T>(method, path, { ...options, _retried: true });
      }
      emitUnauthorized();
      throw new ApiError(i18nText("登录已过期，请重新登录", "Sign-in expired. Please sign in again."), { status: 401, code: 10000, kind: "http" });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ApiError(`HTTP ${response.status}`, { status: response.status, kind: "http" });
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
        this.refreshing = this.refreshAndRetry().finally(() => {
          this.refreshing = null;
        });
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
      // Reject all queued requests and emit unauthorized to trigger logout.
      const queue = this.retryQueue.splice(0);
      queue.forEach((item) => item.reject(error));
      emitUnauthorized();
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
