import { ApiError, type ApiEnvelope, type RuntimeTransport, type UnknownRecord } from "./types";
import { i18nText } from "./i18n-text";

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
  auth?: boolean;
  raw?: boolean;
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

  constructor(
    private readonly runtime: RuntimeTransport,
    private baseUrl = API_BASE_URL,
  ) {}

  setBaseUrl(baseUrl: string) {
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

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
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
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(error instanceof Error ? error.message : i18nText("网络请求失败", "Network request failed"), { kind: "network" });
    }

    if (response.status === 401) {
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

  get<T>(path: string, options?: RequestOptions) {
    return this.request<T>("GET", path, options);
  }

  post<T>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>("POST", path, { ...options, body });
  }

  put<T>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>("PUT", path, { ...options, body });
  }

  delete<T>(path: string, options?: RequestOptions) {
    return this.request<T>("DELETE", path, options);
  }
}
