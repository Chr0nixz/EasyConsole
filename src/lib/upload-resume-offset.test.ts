import { describe, expect, it } from "vitest";

import { ApiClient } from "./api-client";
import { createEasyConsoleApi, resolveUploadResumeOffset, UPLOAD_CHUNK_SIZE } from "./api-factory";
import type { RuntimeHttpRequest, RuntimeTransport } from "./types";

describe("resolveUploadResumeOffset", () => {
  it("uses the first missing chunk index for sparse uploadedChunks", () => {
    expect(resolveUploadResumeOffset([0, 2], UPLOAD_CHUNK_SIZE, UPLOAD_CHUNK_SIZE * 4)).toBe(UPLOAD_CHUNK_SIZE);
  });

  it("returns file size when all chunks are present", () => {
    expect(resolveUploadResumeOffset([0, 1], UPLOAD_CHUNK_SIZE, UPLOAD_CHUNK_SIZE * 2)).toBe(UPLOAD_CHUNK_SIZE * 2);
  });

  it("does not treat array length as contiguous offset", () => {
    expect(resolveUploadResumeOffset([5, 6], UPLOAD_CHUNK_SIZE, UPLOAD_CHUNK_SIZE * 8)).toBe(0);
  });

  it("resumes from the local checkpoint when the server status endpoint is missing", async () => {
    const calls: RuntimeHttpRequest[] = [];
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
      storage: { async get() { return null; }, async set() {}, async remove() {} },
      secureStorage: { async get() { return null; }, async set() {}, async remove() {} },
      async request<T = unknown>(request: RuntimeHttpRequest) {
        calls.push(request);
        if (request.url.includes("chunked_upload_status")) {
          return { status: 404, headers: new Headers(), data: null as T };
        }
        if (request.url.includes("chunked_upload_complete")) {
          return { status: 200, headers: new Headers(), data: { code: 0, data: { ok: true } } as T };
        }
        return { status: 200, headers: new Headers(), data: { upload_id: "u-1" } as T };
      },
      async createWebSocket() { throw new Error("not implemented"); },
      async copyText() {},
      async readClipboardText() { return ""; },
      async getSystemNotificationPermission() { return "unsupported"; },
      async requestSystemNotificationPermission() { return "unsupported"; },
      async notifySystem() { return "unsupported"; },
      openExternal() {},
      async openLocalPath() {},
      async revealLocalPath() {},
      async openSshSession() { return "session"; },
      async writeSshSession() {},
      async resizeSshSession() {},
      async closeSshSession() {},
      async onSshSessionEvent() { return () => {}; },
      async listKnownHosts() { return []; },
      async removeKnownHost() {},
      async clearKnownHosts() {},
      async confirmKnownHost() {},
      async openSystemSshTerminal() {},
      async openVscodeSsh() {},
      async openSshWindow() {},
      async sftpList() { return []; },
      async sftpUpload() {},
      async sftpDownload() {},
      async sftpDelete() {},
      async sftpRename() {},
      async sftpMkdir() {},
      async onSftpProgress() { return () => {}; },
      async startPortForward() {},
      async stopPortForward() {},
      async onPortForwardStatus() { return () => {}; },
      async listSshHistory() { return []; },
      async addSshHistory() {},
      async clearSshHistory() {},
      async setDesktopCloseToTray() {},
      async setDesktopClosePrompt() {},
      async cancelDesktopClosePrompt() {},
      async completeDesktopClosePrompt() {},
      async showDesktopMainWindow() {},
      async hideDesktopTrayMenu() {},
      async runDueScheduledTasks() {},
      async quitDesktopApp() {},
      async onDesktopCloseRequested() { return () => {}; },
      async onDesktopRunDueScheduledTasks() { return () => {}; },
      async onDeepLink() { return () => {}; },
    };

    const api = createEasyConsoleApi(new ApiClient(runtime, "http://host/api"));
    const file = new File([new Uint8Array(UPLOAD_CHUNK_SIZE * 2)], "big.bin");

    await api.storageApi.uploadFile(file, "/uploads", undefined, undefined, {
      uploadId: "u-1",
      completedChunks: [0],
    });

    const chunkPosts = calls.filter(
      (call) => call.method === "POST" && call.url.includes("/storage/chunked_upload") && !call.url.includes("complete"),
    );
    expect(chunkPosts).toHaveLength(1);
    expect(chunkPosts[0]?.headers?.["Content-Range"]).toBe(
      `bytes ${UPLOAD_CHUNK_SIZE}-${UPLOAD_CHUNK_SIZE * 2 - 1}/${UPLOAD_CHUNK_SIZE * 2}`,
    );
  });
});
