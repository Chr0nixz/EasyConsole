import { scheduleNextRun, STALE_LEASE_MS, resetStaleRunningTasks } from "./scheduled-tasks";
import type { ScheduledTask } from "./types";

export { STALE_LEASE_MS, resetStaleRunningTasks as reconcileStaleRunningTasks };

export function makeExecutionKey(task: Pick<ScheduledTask, "id" | "scheduleTime">) {
  return `${task.id}@${task.scheduleTime}`;
}

function nowIso() {
  return new Date().toISOString();
}

/** Mark a due task as running with a lease before calling the remote API. */
export function beginScheduledExecution(task: ScheduledTask, now = new Date()): ScheduledTask {
  return {
    ...task,
    status: "running",
    executionKey: makeExecutionKey(task),
    leaseStartedAt: now.toISOString(),
    lastError: undefined,
    updatedAt: nowIso(),
  };
}

/**
 * After remote create succeeds: record remote id, then advance recurrence (or mark done).
 * Clears the active lease fields except lastRemoteTaskId for audit.
 */
export function completeScheduledExecution(
  task: ScheduledTask,
  remoteTaskId: string | undefined,
  now = new Date(),
): ScheduledTask {
  const withRemote: ScheduledTask = {
    ...task,
    lastRemoteTaskId: remoteTaskId,
    lastRunAt: now.toISOString(),
    lastError: undefined,
    leaseStartedAt: undefined,
  };
  const next = scheduleNextRun(withRemote, now);
  if (!next) {
    return { ...withRemote, status: "done", updatedAt: nowIso() };
  }
  return {
    ...next,
    lastRemoteTaskId: remoteTaskId,
    executionKey: undefined,
    leaseStartedAt: undefined,
  };
}

export function failScheduledExecution(task: ScheduledTask, error: string, now = new Date()): ScheduledTask {
  return {
    ...task,
    status: "failed",
    lastRunAt: now.toISOString(),
    lastError: error,
    leaseStartedAt: undefined,
    updatedAt: nowIso(),
  };
}

/** True when this execution key already produced a remote task (idempotent skip). */
export function alreadyCompletedExecution(task: ScheduledTask, executionKey: string) {
  return Boolean(task.lastRemoteTaskId && task.executionKey === executionKey && task.status !== "running");
}
