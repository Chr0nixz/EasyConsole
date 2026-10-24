import { useSyncExternalStore } from "react";

/**
 * Failures the user has not looked at yet in this session: task route ids that turned
 * failed or abnormal after the app started watching. Opening the task list clears them
 * all; opening one task's detail page clears that task. Session-scoped on purpose: the
 * task list itself is the record, this is only the "something broke since you looked" cue.
 */
let unseen: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function emit(next: ReadonlySet<string>) {
  if (next === unseen) return;
  unseen = next;
  for (const listener of listeners) listener();
}

export function recordUnseenTaskFailure(routeId: string) {
  if (!routeId || unseen.has(routeId)) return;
  emit(new Set(unseen).add(routeId));
}

/** Without an id, marks every unseen failure as seen. */
export function markTaskFailuresSeen(routeId?: string) {
  if (routeId === undefined) {
    if (unseen.size > 0) emit(new Set());
    return;
  }
  if (!unseen.has(routeId)) return;
  const next = new Set(unseen);
  next.delete(routeId);
  emit(next);
}

export function getUnseenTaskFailureCount() {
  return unseen.size;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useUnseenTaskFailureCount() {
  return useSyncExternalStore(subscribe, getUnseenTaskFailureCount, getUnseenTaskFailureCount);
}
