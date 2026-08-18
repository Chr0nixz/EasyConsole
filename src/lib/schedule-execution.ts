import { mutateScheduledTasks, scheduleNextRun, STALE_LEASE_MS, resetStaleRunningTasks, updateScheduledTask } from "./scheduled-tasks";
import { RecurrenceValidationError } from "./task-recurrence";
import type { CreateTaskPayload, RuntimeStorage, ScheduledTask } from "./types";

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

export function extractRemoteTaskId(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, unknown>;
  const id = record.id ?? record.task_id ?? record.taskId;
  if (id === undefined || id === null || id === "") return undefined;
  return String(id);
}

function isFreshLease(task: ScheduledTask, now: Date, staleMs: number) {
  if (task.status !== "running") return false;
  const started = task.leaseStartedAt ? Date.parse(task.leaseStartedAt) : NaN;
  return Number.isFinite(started) && now.getTime() - started < staleMs;
}

export type ExecuteScheduledTaskDeps = {
  createTask: (payload: CreateTaskPayload) => Promise<unknown>;
  preparePayload?: (payload: CreateTaskPayload) => Promise<CreateTaskPayload>;
  /**
   * User-initiated run (page "Run now" / CLI). Claims even when the row is not
   * pending. Auto-runners must leave this unset so failed/needs_review rows are
   * never replayed.
   */
  force?: boolean;
  now?: Date;
  staleMs?: number;
};

export type ExecuteScheduledTaskSkipReason = "already-completed" | "in-flight" | "not-runnable";

export type ExecuteScheduledTaskResult =
  | { skipped: true; reason: ExecuteScheduledTaskSkipReason; task: ScheduledTask }
  | { skipped: false; task: ScheduledTask; remoteTaskId?: string; result: unknown };

/**
 * Claim a lease, create the remote instance, then record the outcome.
 *
 * Shared by the background runner, the scheduled-tasks page, and the CLI/MCP
 * `runScheduledTask` wrapper. Network I/O stays outside the storage lock.
 */
export async function executeScheduledTask(
  storage: RuntimeStorage,
  taskId: string,
  deps: ExecuteScheduledTaskDeps,
): Promise<ExecuteScheduledTaskResult> {
  const now = deps.now ?? new Date();
  const staleMs = deps.staleMs ?? STALE_LEASE_MS;
  const force = deps.force === true;

  type Claim =
    | { kind: "skipped"; reason: ExecuteScheduledTaskSkipReason; task: ScheduledTask }
    | { kind: "leased"; task: ScheduledTask };

  let claim: Claim | undefined;
  await mutateScheduledTasks(storage, (current) => {
    const latest = current.find((item) => item.id === taskId);
    if (!latest) throw new Error(`Scheduled task not found: ${taskId}`);
    const executionKey = makeExecutionKey(latest);

    if (isFreshLease(latest, now, staleMs)) {
      claim = { kind: "skipped", reason: "in-flight", task: latest };
      return current;
    }

    if (latest.status === "running") {
      const reviewed: ScheduledTask = {
        ...latest,
        status: "needs_review",
        lastError:
          latest.lastRemoteTaskId && latest.executionKey
            ? `Lease expired after remote create (${latest.lastRemoteTaskId}); confirm before replaying.`
            : "Lease expired while running; result unknown — confirm before replaying.",
        leaseStartedAt: undefined,
        updatedAt: now.toISOString(),
      };
      if (latest.lastRemoteTaskId || !force) {
        claim = { kind: "skipped", reason: "not-runnable", task: reviewed };
        return updateScheduledTask(current, reviewed);
      }
    } else if (alreadyCompletedExecution(latest, executionKey) && (latest.status === "needs_review" || !force)) {
      claim = { kind: "skipped", reason: "already-completed", task: latest };
      return current;
    } else if (!force && latest.status !== "pending") {
      claim = { kind: "skipped", reason: "not-runnable", task: latest };
      return current;
    }

    const leased = beginScheduledExecution(latest, now);
    claim = { kind: "leased", task: leased };
    return updateScheduledTask(current, leased);
  });

  if (!claim) throw new Error(`Scheduled task not found: ${taskId}`);
  if (claim.kind === "skipped") {
    return { skipped: true, reason: claim.reason, task: claim.task };
  }

  const leased = claim.task;
  try {
    const prepared = deps.preparePayload ? await deps.preparePayload(leased.payload) : leased.payload;
    const result = await deps.createTask(prepared);
    const remoteTaskId = extractRemoteTaskId(result);

    let completed: ScheduledTask | undefined;
    await mutateScheduledTasks(storage, (current) => {
      const withRemote: ScheduledTask = {
        ...leased,
        lastRemoteTaskId: remoteTaskId,
        lastRunAt: now.toISOString(),
      };
      try {
        completed = completeScheduledExecution(withRemote, remoteTaskId, now);
      } catch (error) {
        const message = error instanceof RecurrenceValidationError ? error.message : error instanceof Error ? error.message : String(error);
        completed = {
          ...withRemote,
          status: "needs_review",
          lastError: message,
          leaseStartedAt: undefined,
          updatedAt: now.toISOString(),
        };
      }
      return updateScheduledTask(current, completed);
    });

    return { skipped: false, task: completed ?? leased, remoteTaskId, result };
  } catch (error) {
    const failed = failScheduledExecution(leased, error instanceof Error ? error.message : String(error), now);
    await mutateScheduledTasks(storage, (current) => updateScheduledTask(current, failed));
    throw error;
  }
}

