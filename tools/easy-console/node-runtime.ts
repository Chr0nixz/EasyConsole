import type { RuntimeHttpRequest, RuntimeHttpResponse, RuntimeStorage, RuntimeTransport } from "../../src/lib/types";

type FetchLike = typeof fetch;

export type NodeRuntimeOptions = {
  fetch?: FetchLike;
};

const memoryStorage = new Map<string, string>();

const nodeStorage: RuntimeStorage = {
  async get(key) {
    return memoryStorage.get(key) ?? null;
  },
  async set(key, value) {
    memoryStorage.set(key, value);
  },
  async remove(key) {
    memoryStorage.delete(key);
  },
};

function buildUrl(url: string, query?: Record<string, unknown>) {
  const next = new URL(url);
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

function unsupported(name: string): never {
  throw new Error(`${name} is not available in the EasyConsole Node runtime`);
}

export function createNodeRuntime(options: NodeRuntimeOptions = {}): RuntimeTransport {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) throw new Error("Node fetch is not available");

  async function request<T = unknown>(requestOptions: RuntimeHttpRequest): Promise<RuntimeHttpResponse<T>> {
    const controller = new AbortController();
    const timeoutMs = requestOptions.timeoutMs ?? 20_000;
    const timeout =
      timeoutMs > 0
        ? setTimeout(() => {
            controller.abort();
          }, timeoutMs)
        : undefined;
    const abortFromCaller = () => controller.abort();
    requestOptions.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const headers = { ...(requestOptions.headers ?? {}) };
    const body = normalizeBody(requestOptions.body, headers);

    try {
      const response = await fetcher(buildUrl(requestOptions.url, requestOptions.query), {
        method: requestOptions.method,
        headers,
        body,
        signal: controller.signal,
      });
      const responseType = requestOptions.responseType ?? "json";
      let data: unknown;
      if (responseType === "blob") {
        data = await response.blob();
      } else if (responseType === "text") {
        data = await response.text();
      } else {
        const text = await response.text();
        data = text ? JSON.parse(text) : null;
      }
      return { status: response.status, headers: response.headers, data: data as T };
    } finally {
      requestOptions.signal?.removeEventListener("abort", abortFromCaller);
      if (timeout) clearTimeout(timeout);
    }
  }

  return {
    isDesktop: false,
    isMobile: false,
    runtimeKind: "web",
    runLogChannel: "web",
    supportsTray: false,
    supportsSystemTerminal: false,
    supportsInAppSsh: false,
    supportsUpdater: false,
    supportsFileReveal: false,
    storage: nodeStorage,
    secureStorage: nodeStorage,
    request,
    async createWebSocket() {
      return unsupported("WebSocket");
    },
    async copyText() {
      return unsupported("Clipboard");
    },
    async readClipboardText() {
      return unsupported("Clipboard");
    },
    async requestSystemNotificationPermission() {
      return "unsupported";
    },
    async notifySystem() {
      return "unsupported";
    },
    openExternal() {
      return unsupported("External URL opening");
    },
    async openLocalPath() {
      return unsupported("Local path opening");
    },
    async revealLocalPath() {
      return unsupported("Local path reveal");
    },
    async openSshSession() {
      return unsupported("SSH session");
    },
    async writeSshSession() {
      return unsupported("SSH session write");
    },
    async resizeSshSession() {
      return unsupported("SSH session resize");
    },
    async closeSshSession() {
      return unsupported("SSH session close");
    },
    async onSshSessionEvent() {
      return unsupported("SSH session events");
    },
    async listKnownHosts() {
      return [];
    },
    async removeKnownHost() {
      return unsupported("Known hosts management");
    },
    async clearKnownHosts() {
      return unsupported("Known hosts management");
    },
    async openSystemSshTerminal() {
      return unsupported("System SSH terminal");
    },
    async openVscodeSsh() {
      return unsupported("VS Code SSH");
    },
    async sftpList() {
      return unsupported("SFTP");
    },
    async sftpUpload() {
      return unsupported("SFTP");
    },
    async sftpDownload() {
      return unsupported("SFTP");
    },
    async sftpDelete() {
      return unsupported("SFTP");
    },
    async sftpRename() {
      return unsupported("SFTP");
    },
    async sftpMkdir() {
      return unsupported("SFTP");
    },
    async onSftpProgress() {
      return unsupported("SFTP progress");
    },
    async startPortForward() {
      return unsupported("Port forwarding");
    },
    async stopPortForward() {
      return unsupported("Port forwarding");
    },
    async onPortForwardStatus() {
      return unsupported("Port forwarding status");
    },
    async listSshHistory() {
      return [];
    },
    async addSshHistory() {
      return unsupported("SSH history");
    },
    async clearSshHistory() {
      return unsupported("SSH history");
    },
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
}
