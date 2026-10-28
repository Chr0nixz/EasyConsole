import { describe, expect, it, vi } from "vitest";

import { ApiClient, UNAUTHORIZED_EVENT, extractToken, isAuthError, joinUrl, normalizeToken, unwrapEnvelope } from "./api-client";
import { ApiError, type RuntimeHttpRequest, type RuntimeTransport } from "./types";
import * as transportSecurity from "./transport-security";

function createRuntime() {
  const calls: unknown[] = [];
  const runtime: RuntimeTransport = {
    isDesktop: false,
    isMobile: false,
    runtimeKind: "web",
    runLogChannel: "web",
    supportsTray: false,
    supportsSystemTerminal: false,
    supportsInAppSsh: false,
    supportsSshPopOut: false,
    supportsUpdater: false,
    supportsFileReveal: false,
    supportsAutostart: false,
    storage: {
      async get() {
        return null;
      },
      async set() {},
      async remove() {},
    },
    secureStorage: {
      async get() {
        return null;
      },
      async set() {},
      async remove() {},
    },
    async request<T = unknown>(request: RuntimeHttpRequest) {
      calls.push(request);
      return {
        status: 200,
        headers: new Headers(),
        data: { code: 0, msg: "ok", data: { ok: true } } as T,
      };
    },
    async createWebSocket(url) {
      const socket = new WebSocket(url);
      return {
        get readyState() {
          return socket.readyState;
        },
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        send(data: string) {
          socket.send(data);
        },
        close() {
          socket.close();
        },
      };
    },
    async copyText() {},
    async readClipboardText() { return ""; },
    async getSystemNotificationPermission() {
      return "unsupported";
    },
    async requestSystemNotificationPermission() {
      return "unsupported";
    },
    async notifySystem() {
      return "unsupported";
    },
    openExternal() {},
    async openLocalPath() {},
    async revealLocalPath() {},
    async revealSftpLocalPath() {},
    async openSshSession() {
      return "session-1";
    },
    async writeSshSession() {},
    async acknowledgeSshOutput() {},
    async resizeSshSession() {},
    async closeSshSession() {},
    async onSshSessionEvent() {
      return () => {};
    },
    async listKnownHosts() { return []; },
    async removeKnownHost() {},
    async clearKnownHosts() {},
    async confirmKnownHost() {},
    async openSystemSshTerminal() {},
    async openVscodeSsh() {},
    async openSshWindow() {},
    async sftpRegisterLocalRoot() {},
    async hasLegacyVscodeKey() {
      return false;
    },
    async cleanupLegacyVscodeKey() {},
    async listVscodeSshKeys() {
      return [];
    },
    async revokeVscodeSsh() {},
    async sftpList() { return []; },
    async sftpUpload() {
      return { transferId: "t", operation: "upload", status: "completed", transferred: 0, total: 0 };
    },
    async sftpDownload() {
      return { transferId: "t", operation: "download", status: "completed", transferred: 0, total: 0 };
    },
    async sftpDelete() {},
    async sftpRename() {},
    async sftpMkdir() {},
    async sftpCancel() {},
    async onSftpProgress() { return () => {}; },
    async startPortForward() { return 2222; },
    async stopPortForward() {},
    async onPortForwardStatus() { return () => {}; },
    async listSshHistory() { return []; },
    async addSshHistory() {},
    async clearSshHistory() {},
    async setDesktopCloseToTray() {},
    async setDesktopClosePrompt() {},
    async cancelDesktopClosePrompt() {},
    async completeDesktopClosePrompt() {},
    async getDesktopAutostart() {
      return false;
    },
    async setDesktopAutostart() {},
    async readTaskGpuUtilization() { return null; },
    async showDesktopMainWindow() {},
    async hideDesktopTrayMenu() {},
    async runDueScheduledTasks() {},
    async quitDesktopApp() {},
    async onDesktopCloseRequested() {
      return () => {};
    },
    async onDesktopRunDueScheduledTasks() {
      return () => {};
    },
    async onDeepLink() {
      return () => {};
    },
  };
  return { runtime, calls };
}

describe("api client", () => {
  it("joins base url and path", () => {
    expect(joinUrl("http://host/api/", "/user/token")).toBe("http://host/api/user/token");
  });

  it("unwraps successful envelopes", () => {
    expect(unwrapEnvelope({ code: 0, data: { id: 1 } })).toEqual({ id: 1 });
  });

  it("throws business errors", () => {
    expect(() => unwrapEnvelope({ code: 10040, msg: "no permission", data: null })).toThrow(ApiError);
  });

  it("extracts token variants", () => {
    expect(extractToken({ access_token: "abc" })).toBe("abc");
  });

  it("normalizes bearer tokens", () => {
    expect(normalizeToken("abc")).toBe("Bearer abc");
    expect(normalizeToken("Bearer abc")).toBe("Bearer abc");
  });

  it("injects authorization header", async () => {
    const { runtime, calls } = createRuntime();
    const client = new ApiClient(runtime, "http://host/api");
    client.setToken("token-1");
    await client.get("/demo");
    expect(calls[0]).toMatchObject({ headers: { Authorization: "token-1" } });
  });

  it("uses updated base url for later requests", async () => {
    const { runtime, calls } = createRuntime();
    const client = new ApiClient(runtime, "http://old-host/api");
    client.setBaseUrl("http://new-host/api");

    await client.get("/demo");

    expect(client.getBaseUrl()).toBe("http://new-host/api");
    expect(calls[0]).toMatchObject({ url: "http://new-host/api/demo" });
  });

  it("refreshes and retries POST after 401", async () => {
    const { runtime, calls } = createRuntime();
    let attempt = 0;
    runtime.request = async <T = unknown>(request: RuntimeHttpRequest) => {
      calls.push(request);
      attempt += 1;
      if (attempt === 1) {
        return { status: 401, headers: new Headers(), data: null as T };
      }
      return {
        status: 200,
        headers: new Headers(),
        data: { code: 0, msg: "ok", data: { ok: true } } as T,
      };
    };

    const client = new ApiClient(runtime, "http://host/api");
    client.setToken("Bearer old");
    client.setRefreshTokenHandler(async () => "Bearer refreshed");

    const result = await client.post<{ ok: boolean }>("/mutate", { value: 1 });

    expect(result).toEqual({ ok: true });
    expect(client.getToken()).toBe("Bearer refreshed");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ method: "POST", url: "http://host/api/mutate" });
    expect(calls[1]).toMatchObject({
      method: "POST",
      url: "http://host/api/mutate",
      headers: { Authorization: "Bearer refreshed" },
    });
  });

  it("emits unauthorized when refresh fails after POST 401", async () => {
    const { runtime } = createRuntime();
    runtime.request = async <T = unknown>() => ({ status: 401, headers: new Headers(), data: null as T });

    const client = new ApiClient(runtime, "http://host/api");
    client.setToken("Bearer old");
    client.setRefreshTokenHandler(async () => null);

    await expect(client.post("/mutate", { value: 1 })).rejects.toThrow(/Token refresh returned null|Sign-in expired|登录已过期/);
  });

  it("rejects remote cleartext base urls and requests when policy enforces", async () => {
    const spy = vi.spyOn(transportSecurity, "shouldEnforceSecureRemoteTransport").mockReturnValue(true);
    try {
      const { runtime, calls } = createRuntime();
      const client = new ApiClient(runtime, "https://secure.example/api");
      expect(() => client.setBaseUrl("http://example.com/api")).toThrow(/HTTPS|明文|cleartext/i);
      expect(() => client.setBaseUrl("http://127.0.0.1:28080/api")).not.toThrow();

      const insecure = new ApiClient(runtime, "http://example.com/api");
      await expect(insecure.get("/demo")).rejects.toThrow(/HTTPS|明文|cleartext/i);
      expect(calls).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("replays all queued 401s after a single (single-flight) refresh", async () => {
    const { runtime, calls } = createRuntime();
    let refreshCalls = 0;
    runtime.request = async <T = unknown>(request: RuntimeHttpRequest) => {
      calls.push(request);
      if (request.url.endsWith("/user/refresh_token")) {
        refreshCalls += 1;
        return { status: 200, headers: new Headers(), data: { code: 0, msg: "ok", data: { token: "Bearer fresh" } } as T };
      }
      if (request.headers?.Authorization === "Bearer fresh") {
        return { status: 200, headers: new Headers(), data: { code: 0, msg: "ok", data: { ok: true } } as T };
      }
      return { status: 401, headers: new Headers(), data: null as T };
    };

    const client = new ApiClient(runtime, "http://host/api");
    client.setToken("Bearer old");
    // Mirrors the auth-context handler: the refresh request reuses this client
    // and must bypass the refresh queue itself.
    client.setRefreshTokenHandler(async (token) => {
      const data = await client.post<unknown>("/user/refresh_token", { token }, { auth: false, _skipRefresh: true });
      return extractToken(data);
    });

    const results = await Promise.all([client.get("/a"), client.get("/b"), client.post("/c", { value: 1 })]);

    expect(results.map((item) => (item as { ok: boolean }).ok)).toEqual([true, true, true]);
    expect(refreshCalls).toBe(1);
    expect(client.getToken()).toBe("Bearer fresh");
  });

  it("rejects the whole queue without hanging when the refresh endpoint itself returns 401", async () => {
    const { runtime } = createRuntime();
    runtime.request = async <T = unknown>() => ({ status: 401, headers: new Headers(), data: null as T });

    const client = new ApiClient(runtime, "http://host/api");
    client.setToken("Bearer old");
    client.setRefreshTokenHandler(async (token) => {
      try {
        await client.post<unknown>("/user/refresh_token", { token }, { auth: false, _skipRefresh: true });
        return "Bearer fresh";
      } catch {
        return null;
      }
    });

    const unauthorized = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, unauthorized);
    let settled: PromiseSettledResult<unknown>[];
    try {
      // Under the pre-fix deadlock both requests stayed pending forever.
      settled = await Promise.allSettled([client.get("/a"), client.get("/b")]);
    } finally {
      window.removeEventListener(UNAUTHORIZED_EVENT, unauthorized);
    }

    expect(settled.every((item) => item.status === "rejected")).toBe(true);
    for (const item of settled) {
      if (item.status !== "rejected") continue;
      expect(item.reason).toBeInstanceOf(ApiError);
      expect(isAuthError(item.reason)).toBe(true);
    }
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it("releases the queue with the original error and keeps the session when refresh hits a network failure", async () => {
    const { runtime } = createRuntime();
    runtime.request = async <T = unknown>() => ({ status: 401, headers: new Headers(), data: null as T });

    const client = new ApiClient(runtime, "http://host/api");
    client.setToken("Bearer old");
    const networkError = new ApiError("socket hang up", { kind: "network" });
    // Mirrors the auth-context handler: transient network errors are rethrown.
    client.setRefreshTokenHandler(async () => {
      throw networkError;
    });

    const unauthorized = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, unauthorized);
    let settled: PromiseSettledResult<unknown>[];
    try {
      settled = await Promise.allSettled([client.get("/a"), client.post("/b", { value: 1 })]);
    } finally {
      window.removeEventListener(UNAUTHORIZED_EVENT, unauthorized);
    }

    expect(settled.every((item) => item.status === "rejected")).toBe(true);
    for (const item of settled) {
      if (item.status === "rejected") expect(item.reason).toBe(networkError);
    }
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it("drains a first-time 401 that arrives while the previous cycle is replaying", async () => {
    const { runtime } = createRuntime();
    let refreshCalls = 0;
    let clientRef: ApiClient | null = null;
    let lateRequest: Promise<{ source: string }> | null = null;
    runtime.request = async <T = unknown>(request: RuntimeHttpRequest) => {
      if (request.url.endsWith("/user/refresh_token")) {
        refreshCalls += 1;
        return {
          status: 200,
          headers: new Headers(),
          data: { code: 0, msg: "ok", data: { token: `Bearer fresh-${refreshCalls}` } } as T,
        };
      }
      const authorization = request.headers?.Authorization ?? "";
      if (request.url.endsWith("/a") && authorization === "Bearer fresh-1") {
        // The replayed request succeeds and, like a refetch triggered by fresh
        // data, kicks off a brand-new request that also hits 401 — while the
        // first refresh cycle is still replaying.
        lateRequest = clientRef!.get<{ source: string }>("/c");
        return { status: 200, headers: new Headers(), data: { code: 0, msg: "ok", data: { source: "a" } } as T };
      }
      if (request.url.endsWith("/c") && authorization === "Bearer fresh-2") {
        return { status: 200, headers: new Headers(), data: { code: 0, msg: "ok", data: { source: "c" } } as T };
      }
      return { status: 401, headers: new Headers(), data: null as T };
    };

    const client = new ApiClient(runtime, "http://host/api");
    clientRef = client;
    client.setToken("Bearer old");
    client.setRefreshTokenHandler(async (token) => {
      const data = await client.post<unknown>("/user/refresh_token", { token }, { auth: false, _skipRefresh: true });
      return extractToken(data);
    });

    const a = await client.get<{ source: string }>("/a");

    expect(a.source).toBe("a");
    // Without the follow-up drain cycle this late 401 would hang forever.
    const c = await Promise.race([
      lateRequest!,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("late 401 was never drained by a follow-up refresh cycle")), 2_000);
      }),
    ]);
    expect(c.source).toBe("c");
    expect(refreshCalls).toBe(2);
  });
});
