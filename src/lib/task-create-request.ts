/**
 * Lets the command palette ask the task list to open its create dialog, whether or not
 * the list is mounted yet: a request made before mount is consumed by the page's initial
 * state, one made while it is open is delivered to its subscriber.
 */
let pending = false;
const listeners = new Set<() => void>();

export function requestCreateTask() {
  if (listeners.size === 0) {
    pending = true;
    return;
  }
  for (const listener of listeners) listener();
}

/** Returns true once if a request arrived before the task list mounted. */
export function consumePendingCreateTaskRequest() {
  const value = pending;
  pending = false;
  return value;
}

export function subscribeCreateTaskRequests(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
