import { i18nText } from "./i18n-text";
import type { DownloadQueueItem } from "./types";

export function createDownloadQueueId() {
  return `download-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function summarizeDownloadQueue(items: DownloadQueueItem[]) {
  const active = items.filter((item) => item.status === "queued" || item.status === "downloading");
  const completed = items.filter((item) => item.status === "done").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const cancelled = items.filter((item) => item.status === "cancelled").length;
  const downloading = items.find((item) => item.status === "downloading");
  const weightedTotal = items.reduce((sum, item) => sum + (item.total ?? 0), 0);
  const weightedLoaded = items.reduce((sum, item) => sum + Math.min(item.loaded, item.total ?? item.loaded), 0);
  const averageProgress = items.length ? Math.round(items.reduce((sum, item) => sum + item.progress, 0) / items.length) : 0;
  const percent = weightedTotal > 0 ? Math.round((weightedLoaded / weightedTotal) * 100) : averageProgress;

  return {
    total: items.length,
    active: active.length,
    completed,
    failed,
    cancelled,
    downloading,
    percent: Math.min(100, Math.max(0, percent)),
  };
}

export function downloadStatusText(status: DownloadQueueItem["status"]) {
  const labels: Record<DownloadQueueItem["status"], string> = {
    queued: i18nText("排队中", "Queued"),
    downloading: i18nText("下载中", "Downloading"),
    done: i18nText("已完成", "Done"),
    failed: i18nText("失败", "Failed"),
    cancelled: i18nText("已取消", "Cancelled"),
  };
  return labels[status];
}
