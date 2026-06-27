import { describe, expect, it } from "vitest";

import { ApiClient, extractToken, joinUrl, normalizeToken, unwrapEnvelope } from "./api-client";
import { ApiError, type RuntimeHttpRequest, type RuntimeTransport } from "./types";

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
    supportsUpdater: false,
    supportsFileReveal: false,
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
    async requestSystemNotificationPermission() {
      return "unsupported";
    },
    async notifySystem() {
      return "unsupported";
    },
    openExternal() {},
    async openLocalPath() {},
    async revealLocalPath() {},
    async openSshSession() {
      return "session-1";
    },
    async writeSshSession() {},
    async resizeSshSession() {},
    async closeSshSession() {},
    async onSshSessionEvent() {
      return () => {};
    },
    async openSystemSshTerminal() {},
    async openVscodeSsh() {},
    async setDesktopCloseToTray() {},
    async setDesktopClosePrompt() {},
    async cancelDesktopClosePrompt() {},
    async completeDesktopClosePrompt() {},
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
});
