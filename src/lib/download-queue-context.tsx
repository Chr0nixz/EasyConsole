import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { saveBlobToDownloads } from "./download";
import { createDownloadQueueId, summarizeDownloadQueue } from "./download-queue";
import { useI18n } from "./i18n";
import type { DownloadQueueItem } from "./types";
import { errorMessage, useRunLogger } from "./use-run-logger";
import {
  DownloadQueueActionsContext,
  DownloadQueueDataContext,
  type DownloadQueueActions,
  type DownloadQueueData,
  type EnqueueDownloadInput,
} from "./use-download-queue";
import { useToast } from "./use-toast";

type DownloadJob = EnqueueDownloadInput & {
  id: string;
};

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

export function DownloadQueueProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const runLogger = useRunLogger();
  const { text } = useI18n();
  const [items, setItems] = useState<DownloadQueueItem[]>([]);
  const jobsRef = useRef(new Map<string, DownloadJob>());
  const controllersRef = useRef(new Map<string, AbortController>());
  const runningRef = useRef(false);
  const itemsRef = useRef(items);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const runNext = useCallback(() => {
    if (runningRef.current) return;
    const next = itemsRef.current.find((item) => item.status === "queued");
    if (!next) return;
    const job = jobsRef.current.get(next.id);
    if (!job) return;

    runningRef.current = true;
    const controller = new AbortController();
    controllersRef.current.set(next.id, controller);
    const startedAt = new Date().toISOString();
    setItems((current) =>
      current.map((item) =>
        item.id === next.id
          ? { ...item, status: "downloading", progress: Math.max(1, item.progress), error: undefined, updatedAt: startedAt }
          : item,
      ),
    );

    void job
      .request({
        signal: controller.signal,
        onProgress: (progress) => {
          const updatedAt = new Date().toISOString();
          setItems((current) =>
            current.map((item) =>
              item.id === next.id
                ? {
                    ...item,
                    loaded: progress.loaded,
                    total: progress.total,
                    progress: progress.total ? progress.percent : item.progress,
                    updatedAt,
                  }
                : item,
            ),
          );
        },
      })
      .then((blob) => saveBlobToDownloads(blob, job.filename))
      .then((destinationPath) => {
        const updatedAt = new Date().toISOString();
        setItems((current) =>
          current.map((item) =>
            item.id === next.id
              ? { ...item, status: "done", progress: 100, loaded: item.total ?? item.loaded, destinationPath, updatedAt }
              : item,
          ),
        );
        toast.success(job.successTitle, job.filename);
        void runLogger.log({
          source: job.source,
          level: "info",
          action: job.action,
          result: "success",
          title: job.successTitle,
          targetName: job.targetName,
          targetId: job.targetId,
          metadata: { filename: job.filename, destinationPath },
        });
      })
      .catch((error) => {
        const cancelled = controller.signal.aborted || isAbortError(error);
        const message = cancelled ? text("已取消", "Cancelled") : errorMessage(error, job.failureTitle);
        const updatedAt = new Date().toISOString();
        setItems((current) =>
          current.map((item) =>
            item.id === next.id
              ? { ...item, status: cancelled ? "cancelled" : "failed", error: message, updatedAt }
              : item,
          ),
        );
        if (!cancelled) {
          toast.error(job.failureTitle, message);
          void runLogger.log({
            source: job.source,
            level: "error",
            action: job.action,
            result: "failure",
            title: job.failureTitle,
            targetName: job.targetName,
            targetId: job.targetId,
            error: message,
          });
        }
      })
      .finally(() => {
        controllersRef.current.delete(next.id);
        runningRef.current = false;
      });
  }, [runLogger, text, toast]);

  useEffect(() => {
    runNext();
  }, [items, runNext]);

  const enqueue = useCallback((input: EnqueueDownloadInput) => {
    const id = createDownloadQueueId();
    const now = new Date().toISOString();
    jobsRef.current.set(id, { ...input, id });
    setItems((current) => [
      ...current,
      {
        id,
        source: input.source,
        sourceLabel: input.sourceLabel,
        filename: input.filename,
        targetName: input.targetName,
        targetId: input.targetId,
        status: "queued",
        progress: 0,
        loaded: 0,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    toast.info(text("已加入下载队列", "Added to download queue"), input.filename);
    return id;
  }, [text, toast]);

  const cancel = useCallback((id: string) => {
    controllersRef.current.get(id)?.abort();
    const updatedAt = new Date().toISOString();
    setItems((current) =>
      current.map((item) =>
        item.id === id && item.status === "queued"
          ? { ...item, status: "cancelled", error: text("已取消", "Cancelled"), updatedAt }
          : item,
      ),
    );
  }, [text]);

  const retry = useCallback((id: string) => {
    const updatedAt = new Date().toISOString();
    setItems((current) =>
      current.map((item) =>
        item.id === id && (item.status === "failed" || item.status === "cancelled")
          ? { ...item, status: "queued", progress: 0, loaded: 0, total: undefined, error: undefined, updatedAt }
          : item,
      ),
    );
  }, []);

  const clearCompleted = useCallback(() => {
    setItems((current) => {
      const next = current.filter((item) => item.status !== "done" && item.status !== "cancelled");
      const retainedIds = new Set(next.map((item) => item.id));
      for (const id of jobsRef.current.keys()) {
        if (!retainedIds.has(id)) jobsRef.current.delete(id);
      }
      return next;
    });
  }, []);

  const summary = useMemo(() => summarizeDownloadQueue(items), [items]);
  const actions = useMemo<DownloadQueueActions>(
    () => ({ enqueue, cancel, retry, clearCompleted }),
    [cancel, clearCompleted, enqueue, retry],
  );
  const data = useMemo<DownloadQueueData>(() => ({ items, summary }), [items, summary]);

  return (
    <DownloadQueueActionsContext.Provider value={actions}>
      <DownloadQueueDataContext.Provider value={data}>{children}</DownloadQueueDataContext.Provider>
    </DownloadQueueActionsContext.Provider>
  );
}

