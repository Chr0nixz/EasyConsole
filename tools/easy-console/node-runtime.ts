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

function toProgress(loaded: number, total?: number) {
  return { loaded, total, percent: total ? Math.round((loaded / total) * 100) : 0 };
}

async function readBlobWithProgress(
  response: Response,
  onProgress: ((progress: { loaded: number; total?: number; percent: number }) => void) | undefined,
  onChunk: () => void,
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
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value as BlobPart);
    loaded += value.byteLength;
    // Progress proves the connection is alive: reset the idle timeout window.
    onChunk();
    onProgress?.(toProgress(loaded, knownTotal));
  }
  const blob = new Blob(chunks);
  onProgress?.(toProgress(blob.size, knownTotal ?? blob.size));
  return blob;
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
    // Mirrors src/lib/runtime.ts: one overall timeout for JSON/text; for blob
    // (download) requests the timer is re-armed per received chunk once the
    // headers arrive, so only a stalled connection -- not a large or slow
    // body -- trips it. `timeoutMs <= 0` disables it entirely.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const armTimeout = () => {
      if (timeoutMs <= 0) return;
      if (timeout !== undefined) clearTimeout(timeout);
      timeout = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
    };
    const disarmTimeout = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      timeout = undefined;
    };
    armTimeout();
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
        // Headers arrived: restart the timer as the first idle window.
        armTimeout();
        data = await readBlobWithProgress(response, requestOptions.onDownloadProgress, armTimeout);
      } else if (responseType === "text") {
        data = await response.text();
      } else {
        const text = await response.text();
        data = text ? JSON.parse(text) : null;
      }
      return { status: response.status, headers: response.headers, data: data as T };
    } finally {
      requestOptions.signal?.removeEventListener("abort", abortFromCaller);
      disarmTimeout();
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
    supportsSshPopOut: false,
    supportsUpdater: false,
    supportsFileReveal: false,
    supportsAutostart: false,
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
    async getSystemNotificationPermission() {
      return "unsupported";
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
    async revealSftpLocalPath() {
      return unsupported("SFTP local path reveal");
    },
    async openSshSession() {
      return unsupported("SSH session");
    },
    async writeSshSession() {
      return unsupported("SSH session write");
    },
    async acknowledgeSshOutput() {
      return unsupported("SSH output acknowledgement");
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
    async confirmKnownHost() {
      return unsupported("Known hosts confirmation");
    },
    async openSystemSshTerminal() {
      return unsupported("System SSH terminal");
    },
    async openVscodeSsh() {
      return unsupported("VS Code SSH");
    },
    async listVscodeSshKeys() {
      return [];
    },
    async hasLegacyVscodeKey() {
      return false;
    },
    async cleanupLegacyVscodeKey() {},
    async revokeVscodeSsh() {},
    async openSshWindow() {
      return unsupported("Standalone SSH window");
    },
    async sftpRegisterLocalRoot() {},
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
    async sftpCancel() {
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
}
