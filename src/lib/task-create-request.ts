/**
 * Lets the command palette, the dashboard and the Images page ask the task list to open its
 * create dialog, whether or not the list is mounted yet: a request made before mount is
 * consumed by the page's initial state, one made while it is open is delivered to its
 * subscriber. A request may carry a preset (the image to start from).
 */
export type CreateTaskPreset = { imageId?: string };

let pending = false;
let preset: CreateTaskPreset = {};
const listeners = new Set<() => void>();

export function requestCreateTask(next: CreateTaskPreset = {}) {
  preset = next;
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

/** The preset of the latest request, cleared as it is read so a later plain create starts fresh. */
export function takeCreateTaskPreset(): CreateTaskPreset {
  const value = preset;
  preset = {};
  return value;
}

export function subscribeCreateTaskRequests(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
