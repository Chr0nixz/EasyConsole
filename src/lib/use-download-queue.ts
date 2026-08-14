import { createContext, useContext } from "react";

import type { summarizeDownloadQueue } from "./download-queue";
import { formatBytes } from "./format";
import type { DownloadQueueItem, DownloadQueueSource, UploadProgress } from "./types";

export type DownloadRequest = {
  signal: AbortSignal;
  onProgress: (progress: UploadProgress) => void;
};

export type EnqueueDownloadInput = {
  source: DownloadQueueSource;
  sourceLabel: string;
  filename: string;
  targetName: string;
  targetId?: string | number;
  successTitle: string;
  failureTitle: string;
  action: string;
  request: (request: DownloadRequest) => Promise<Blob>;
};

export type DownloadQueueActions = {
  enqueue(input: EnqueueDownloadInput): string;
  cancel(id: string): void;
  retry(id: string): void;
  clearCompleted(): void;
};

export type DownloadQueueData = {
  items: DownloadQueueItem[];
  summary: ReturnType<typeof summarizeDownloadQueue>;
};

export type DownloadQueueContextValue = DownloadQueueActions & DownloadQueueData;

/**
 * Two contexts on purpose.
 *
 * Progress updates change `items` continuously during a download. Components
 * that only start downloads (TasksPage, StoragePage) must not re-render for
 * that -- TasksPage alone carries a virtualized table and a dozen dialogs. The
 * actions object is referentially stable for the provider's lifetime, so those
 * pages subscribe to it and never see progress churn.
 */
export const DownloadQueueActionsContext = createContext<DownloadQueueActions | null>(null);
export const DownloadQueueDataContext = createContext<DownloadQueueData | null>(null);

/** Actions only. Prefer this when the component just starts downloads. */
export function useDownloadQueueActions() {
  const context = useContext(DownloadQueueActionsContext);
  if (!context) throw new Error("useDownloadQueueActions must be used within DownloadQueueProvider");
  return context;
}

/** Actions plus live queue state. Re-renders on every progress update. */
export function useDownloadQueue(): DownloadQueueContextValue {
  const actions = useDownloadQueueActions();
  const data = useContext(DownloadQueueDataContext);
  if (!data) throw new Error("useDownloadQueue must be used within DownloadQueueProvider");
  return { ...actions, ...data };
}

export function formatDownloadProgress(item: DownloadQueueItem) {
  if (item.total) return `${item.progress}% ${formatBytes(item.loaded)} / ${formatBytes(item.total)}`;
  if (item.loaded > 0) return formatBytes(item.loaded);
  return "";
}
