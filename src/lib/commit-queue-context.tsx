import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { imageApi } from "./api";
import { useI18n } from "./i18n";
import type { CommitQueueItem, ImageCommitPayload } from "./types";
import { errorMessage, useRunLogger } from "./use-run-logger";
import { useToast } from "./use-toast";

export type EnqueueCommitInput = {
  taskName: string;
  taskId?: string | number;
  podName: string;
  payload: ImageCommitPayload;
};

type CommitJob = EnqueueCommitInput & {
  id: string;
};

type CommitQueueContextValue = {
  items: CommitQueueItem[];
  summary: { active: number; completed: number; failed: number; total: number };
  enqueue(input: EnqueueCommitInput): string;
  clearCompleted(): void;
};

const CommitQueueContext = createContext<CommitQueueContextValue | null>(null);

function createCommitQueueId() {
  return `commit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function summarizeCommitQueue(items: CommitQueueItem[]) {
  const active = items.filter((item) => item.status === "queued" || item.status === "running").length;
  const completed = items.filter((item) => item.status === "done").length;
  const failed = items.filter((item) => item.status === "failed").length;
  return { active, completed, failed, total: items.length };
}

export function CommitQueueProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const runLogger = useRunLogger();
  const { text } = useI18n();
  const [items, setItems] = useState<CommitQueueItem[]>([]);
  const jobsRef = useRef(new Map<string, CommitJob>());
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
    const startedAt = new Date().toISOString();
    setItems((current) =>
      current.map((item) =>
        item.id === next.id ? { ...item, status: "running", updatedAt: startedAt } : item,
      ),
    );

    void imageApi
      .commitImage(job.payload)
      .then(() => {
        const updatedAt = new Date().toISOString();
        setItems((current) =>
          current.map((item) =>
            item.id === next.id ? { ...item, status: "done", updatedAt } : item,
          ),
        );
        toast.success(text("Commit 完成", "Commit complete"), job.taskName);
        void runLogger.log({
          source: "task",
          level: "info",
          action: "image.commit",
          result: "success",
          title: text("Commit 完成", "Commit complete"),
          targetName: job.taskName,
          targetId: job.taskId,
          metadata: { podName: job.podName },
        });
      })
      .catch((error) => {
        const message = errorMessage(error, text("Commit 失败", "Commit failed"));
        const updatedAt = new Date().toISOString();
        setItems((current) =>
          current.map((item) =>
            item.id === next.id ? { ...item, status: "failed", error: message, updatedAt } : item,
          ),
        );
        toast.error(text("Commit 失败", "Commit failed"), `${job.taskName}: ${message}`);
        void runLogger.log({
          source: "task",
          level: "error",
          action: "image.commit",
          result: "failure",
          title: text("Commit 失败", "Commit failed"),
          targetName: job.taskName,
          targetId: job.taskId,
          error: message,
        });
      })
      .finally(() => {
        runningRef.current = false;
      });
  }, [runLogger, text, toast]);

  useEffect(() => {
    runNext();
  }, [items, runNext]);

  const enqueue = useCallback((input: EnqueueCommitInput) => {
    const id = createCommitQueueId();
    const now = new Date().toISOString();
    jobsRef.current.set(id, { ...input, id });
    setItems((current) => [
      ...current,
      {
        id,
        taskName: input.taskName,
        taskId: input.taskId,
        podName: input.podName,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    toast.info(text("已加入 Commit 队列", "Added to commit queue"), input.taskName);
    return id;
  }, [text, toast]);

  const clearCompleted = useCallback(() => {
    setItems((current) => {
      const next = current.filter((item) => item.status !== "done");
      const retainedIds = new Set(next.map((item) => item.id));
      for (const id of jobsRef.current.keys()) {
        if (!retainedIds.has(id)) jobsRef.current.delete(id);
      }
      return next;
    });
  }, []);

  const summary = useMemo(() => summarizeCommitQueue(items), [items]);
  const value = useMemo<CommitQueueContextValue>(
    () => ({ items, summary, enqueue, clearCompleted }),
    [clearCompleted, enqueue, items, summary],
  );

  return <CommitQueueContext.Provider value={value}>{children}</CommitQueueContext.Provider>;
}

export function useCommitQueue() {
  const context = useContext(CommitQueueContext);
  if (!context) throw new Error("useCommitQueue must be used within CommitQueueProvider");
  return context;
}
