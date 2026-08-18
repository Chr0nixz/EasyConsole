import { getLocalFileRelativePath, joinStoragePath, normalizeStoragePath } from "./remote-storage";
import { i18nText } from "./i18n-text";
import type { UploadQueueItem } from "./types";

function queueId(file: File, index: number) {
  return `${index}-${file.name}-${file.size}-${file.lastModified}`;
}

export function createUploadQueueItems(files: File[], remoteDirectory: string): UploadQueueItem[] {
  const normalizedRemoteDirectory = normalizeStoragePath(remoteDirectory);
  return files.map((file, index) => {
    const relativePath = getLocalFileRelativePath(file);
    const parts = relativePath.split("/").filter(Boolean);
    parts.pop();
    const targetDirectory = parts.reduce((directory, part) => joinStoragePath(directory, part), normalizedRemoteDirectory);
    return {
      id: queueId(file, index),
      file,
      remoteDirectory: targetDirectory,
      relativePath,
      status: file.size === 0 ? "skipped" : "queued",
      progress: file.size === 0 ? 100 : 0,
      skipReason: file.size === 0 ? i18nText("不支持上传空文件", "Uploading empty files is not supported") : undefined,
    };
  });
}

export function summarizeUploadQueue(items: UploadQueueItem[]) {
  const uploadable = items.filter((item) => item.status !== "skipped");
  const completed = items.filter((item) => item.status === "done").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const skipped = items.filter((item) => item.status === "skipped").length;
  const cancelled = items.filter((item) => item.status === "cancelled").length;
  const totalProgress = uploadable.length
    ? Math.round(uploadable.reduce((sum, item) => sum + item.progress, 0) / uploadable.length)
    : 100;
  return {
    total: items.length,
    uploadable: uploadable.length,
    completed,
    failed,
    skipped,
    cancelled,
    percent: Math.min(100, totalProgress),
    active: items.some((item) => item.status === "uploading" || item.status === "queued"),
    succeeded: completed,
  };
}

export type UploadQueueRunResult = {
  succeeded: number;
  failed: number;
  cancelled: number;
  skipped: number;
  items: UploadQueueItem[];
};

export function finalizeUploadQueueResult(items: UploadQueueItem[]): UploadQueueRunResult {
  const summary = summarizeUploadQueue(items);
  return {
    succeeded: summary.completed,
    failed: summary.failed,
    cancelled: summary.cancelled,
    skipped: summary.skipped,
    items: items.map((item) => ({ ...item })),
  };
}
