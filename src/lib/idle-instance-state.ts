import { useSyncExternalStore } from "react";

import type { Task } from "./types";

/** How the watcher reached "idle": real GPU samples over the window, or the CPU/network heuristic alone. */
export type IdleEvidence = "gpu" | "heuristic";

type IdleSnapshot = ReadonlyMap<string, IdleEvidence>;

/**
 * Running instances the idle watcher currently judges idle. In memory only: the watcher
 * re-evaluates within a minute of launch, so a restart never shows a stale idle mark.
 * Rows read it so "possibly idle" stays visible until the instance is active again,
 * stops running, or the user acts, instead of living only in a toast.
 */
let snapshot: IdleSnapshot = new Map();
const listeners = new Set<() => void>();

export function idleInstanceKey(task: Pick<Task, "id" | "task_id">) {
  return String(task.id ?? task.task_id);
}

export function publishIdleInstances(next: IdleSnapshot) {
  const unchanged = next.size === snapshot.size && [...next].every(([key, evidence]) => snapshot.get(key) === evidence);
  if (unchanged) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

export function clearIdleInstances() {
  publishIdleInstances(new Map());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return snapshot;
}

/** The idle evidence for one instance, or null while it is not judged idle. */
export function useIdleEvidence(task: Pick<Task, "id" | "task_id">): IdleEvidence | null {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return current.get(idleInstanceKey(task)) ?? null;
}
