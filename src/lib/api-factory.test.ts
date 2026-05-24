import { describe, expect, it } from "vitest";

import { ApiClient } from "./api-client";
import { createEasyConsoleApi } from "./api-factory";
import type { RuntimeHttpRequest, RuntimeTransport } from "./types";
import { apiClient, authApi, instanceApi } from "./api";

function createRuntime(responseData: unknown) {
  const calls: RuntimeHttpRequest[] = [];
  const runtime: RuntimeTransport = {
    isDesktop: false,
    storage: {
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
        data: responseData as T,
      };
    },
    async createWebSocket() {
      throw new Error("not implemented");
    },
    async copyText() {},
    async requestSystemNotificationPermission() {
      return "unsupported";
    },
    async notifySystem() {
      return "unsupported";
    },
    openExternal() {},
    async openSshSession() {
      return "session";
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
    async onDesktopRunDueScheduledTasks() {
      return () => {};
    },
  };
  return { runtime, calls };
}

describe("api factory", () => {
  it("builds endpoint wrappers with an injected client", async () => {
    const { runtime, calls } = createRuntime({ code: 0, data: { list: [{ id: 1, name: "task" }], total: 1 } });
    const client = new ApiClient(runtime, "http://host/api");
    const api = createEasyConsoleApi(client);

    const result = await api.instanceApi.tasks({ page: 1, page_size: 10 });

    expect(result.items).toEqual([{ id: 1, name: "task" }]);
    expect(calls[0]).toMatchObject({
      method: "GET",
      url: "http://host/api/instance/task",
      query: { page: 1, page_size: 10 },
    });
  });

  it("keeps the browser facade exports available", () => {
    expect(apiClient).toBeInstanceOf(ApiClient);
    expect(typeof authApi.login).toBe("function");
    expect(typeof instanceApi.tasks).toBe("function");
  });

  it("posts image commit requests using the original console endpoint", async () => {
    const { runtime, calls } = createRuntime({ code: 0, data: {} });
    const client = new ApiClient(runtime, "http://host/api");
    const api = createEasyConsoleApi(client);

    await api.imageApi.commitImage({ user: { username: "xutian" }, pod_name: "common-o7mt1awm" });

    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "http://host/api/image/image_commit",
      body: { user: { username: "xutian" }, pod_name: "common-o7mt1awm" },
    });
  });
});
