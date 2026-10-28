import { holdScheduledTaskForReview, LEGACY_SCHEDULED_TASK_OWNER_KEY, mutateScheduledTasks, scheduledTaskOwnerMismatch, scheduleNextRun, STALE_LEASE_MS, resetStaleRunningTasks, updateScheduledTask } from "./scheduled-tasks";
import type { AccountScope } from "./account-scope";
import { applyScheduledReleasePolicy } from "./scheduled-release";
import { isNetworkError } from "./api-client";
import {
  activeExecutionAccount,
  appendExecutionLedgerEntry,
  createExecutionLedgerEntry,
  type ExecutionLedgerEntry,
  type ExecutionTrigger,
} from "./execution-ledger";
import { i18nText } from "./i18n-text";
import { RecurrenceValidationError } from "./task-recurrence";
import type { CreateTaskPayload, RuntimeStorage, ScheduledTask } from "./types";

export { STALE_LEASE_MS, resetStaleRunningTasks as reconcileStaleRunningTasks };

const DEFAULT_PERSIST_RETRY_ATTEMPTS = 2;
const DEFAULT_PERSIST_RETRY_DELAY_MS = 150;

export function makeExecutionKey(task: Pick<ScheduledTask, "id" | "scheduleTime">) {
  return `${task.id}@${task.scheduleTime}`;
}

function nowIso() {
  return new Date().toISOString();
}

function errorMessageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Remote create confirmed but the local completion write kept failing. Keep
 * the remote task id and park the row in needs_review; replaying would create
 * a duplicate remote instance.
 */
function persistFailureReview(withRemote: ScheduledTask, error: unknown, now: Date): ScheduledTask {
  const remoteId = withRemote.lastRemoteTaskId;
  return {
    ...withRemote,
    status: "needs_review",
    lastError: i18nText(
      `远程任务已创建${remoteId ? `（${remoteId}）` : ""}，但本地保存失败：${errorMessageOf(error)}。请先在控制台核对远端任务，切勿重复执行。`,
      `Remote task was created${remoteId ? ` (${remoteId})` : ""} but saving it locally failed: ${errorMessageOf(error)}. Verify the remote task on the console before replaying.`,
    ),
    leaseStartedAt: undefined,
    updatedAt: now.toISOString(),
  };
}

/**
 * The create request failed at the network level: it may still have reached
 * the server. The outcome is unknown, so park in needs_review instead of
 * failed — an automatic retry could create a duplicate remote instance.
 */
function unknownOutcomeReview(task: ScheduledTask, error: unknown, now: Date): ScheduledTask {
  return {
    ...task,
    status: "needs_review",
    lastRunAt: now.toISOString(),
    lastError: i18nText(
      `远程创建结果未知（网络错误）：${errorMessageOf(error)}。请先在控制台核对是否已创建，再决定是否重放。`,
      `Remote create outcome unknown (network error): ${errorMessageOf(error)}. Verify on the console whether the task was created before replaying.`,
    ),
    leaseStartedAt: undefined,
    updatedAt: now.toISOString(),
  };
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
  /** Check ownership under the claim lock and recheck the session before the remote create. */
  getAccountScope?: () => AccountScope;
  /** Explicit CLI/MCP runs may execute an unowned legacy plan; known foreign owners are always checked. */
  allowLegacyOwner?: boolean;
  /**
   * User-initiated run (page "Run now" / CLI). Claims even when the row is not
   * pending. Auto-runners must leave this unset so failed/needs_review rows are
   * never replayed.
   */
  force?: boolean;
  /**
   * How the execution ledger classifies this run: the background schedule
   * (default), a manual "Run now" ("manual"), or the CLI/MCP wrapper ("cli").
   */
  trigger?: ExecutionTrigger;
  now?: Date;
  staleMs?: number;
  /** Extra attempts for the local completion write after a confirmed remote create. */
  persistRetryAttempts?: number;
  /** Base delay between local persistence retries (scaled by attempt). */
  persistRetryDelayMs?: number;
};

export type ExecuteScheduledTaskSkipReason = "already-completed" | "in-flight" | "not-runnable";

/** How a non-skipped execution ended: fully recorded, or remote-created but unpersistable locally. */
export type ExecuteScheduledTaskOutcome = "completed" | "local-persist-failed";

export type ExecuteScheduledTaskResult =
  | { skipped: true; reason: ExecuteScheduledTaskSkipReason; task: ScheduledTask }
  | { skipped: false; outcome: ExecuteScheduledTaskOutcome; task: ScheduledTask; remoteTaskId?: string; result: unknown };

/** Write the completion record, retrying transient local storage failures. */
async function persistCompletionWithRetry(
  storage: RuntimeStorage,
  withRemote: ScheduledTask,
  now: Date,
  deps: ExecuteScheduledTaskDeps,
): Promise<ScheduledTask> {
  const attempts = Math.max(0, deps.persistRetryAttempts ?? DEFAULT_PERSIST_RETRY_ATTEMPTS);
  const delayMs = deps.persistRetryDelayMs ?? DEFAULT_PERSIST_RETRY_DELAY_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    if (attempt > 0 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
    let saved: ScheduledTask | undefined;
    try {
      await mutateScheduledTasks(storage, (current) => {
        try {
          saved = completeScheduledExecution(withRemote, withRemote.lastRemoteTaskId, now);
        } catch (error) {
          const message =
            error instanceof RecurrenceValidationError ? error.message : error instanceof Error ? error.message : String(error);
          saved = {
            ...withRemote,
            status: "needs_review",
            lastError: message,
            leaseStartedAt: undefined,
            updatedAt: now.toISOString(),
          };
        }
        // Merge onto the latest row: concurrent user edits (rename, payload
        // change) survive, while the scheduling transition (status, next
        // scheduleTime, recurrence advance) from the completion wins.
        return current.map((item) =>
          item.id === saved!.id
            ? { ...applyExecutionOutcome(item, saved!), scheduleTime: saved!.scheduleTime, recurrence: saved!.recurrence }
            : item,
        );
      });
      return saved ?? withRemote;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("Scheduled task completion could not be persisted.");
}

/**
 * Overlay an execution outcome onto the latest stored row. Only execution
 * bookkeeping (status, lease, remote id, errors) is overwritten, so edits made
 * from another window while this execution was in flight (rename, schedule
 * change) survive; the outcome never wholesale-replaces the row.
 */
export function applyExecutionOutcome(latest: ScheduledTask, outcome: ScheduledTask): ScheduledTask {
  return {
    ...latest,
    status: outcome.status,
    lastError: outcome.lastError,
    lastRunAt: outcome.lastRunAt ?? latest.lastRunAt,
    lastRemoteTaskId: outcome.lastRemoteTaskId ?? latest.lastRemoteTaskId,
    executionKey: outcome.executionKey ?? latest.executionKey,
    leaseStartedAt: outcome.leaseStartedAt,
    owner: outcome.owner ?? latest.owner,
    updatedAt: outcome.updatedAt,
  };
}

/**
 * Best-effort final write for failure/review markers. Storage may be exactly
 * what is broken; a leftover "running" row is reconciled to needs_review by
 * resetStaleRunningTasks once storage recovers.
 */
async function tryPersistTaskState(storage: RuntimeStorage, outcome: ScheduledTask): Promise<void> {
  try {
    await mutateScheduledTasks(storage, (current) =>
      current.map((item) => (item.id === outcome.id ? applyExecutionOutcome(item, outcome) : item)),
    );
  } catch {
    // Intentionally swallowed: the original remote outcome is the error that
    // matters to the caller, and re-creating the remote task is never an option.
  }
}

/**
 * Land one execution-ledger entry for a finished run. The ledger is an audit
 * trail, never a participant in the execution flow: append failures are
 * swallowed on purpose so a broken ledger can neither fail nor retry a remote
 * create.
 */
async function recordExecutionOutcome(
  storage: RuntimeStorage,
  leased: ScheduledTask,
  trigger: ExecutionTrigger,
  startedAt: string,
  outcome: ExecutionLedgerEntry["outcome"],
  extra: { remoteTaskId?: string; error?: string; accountScope?: AccountScope } = {},
): Promise<void> {
  try {
    await appendExecutionLedgerEntry(
      storage,
      createExecutionLedgerEntry({
        scheduledTaskId: leased.id,
        scheduledTaskName: leased.name,
        trigger,
        ...(extra.accountScope
          ? { accountKey: extra.accountScope.key, accountDisplayName: extra.accountScope.displayName }
          : activeExecutionAccount()),
        startedAt,
        finishedAt: new Date().toISOString(),
        outcome,
        remoteTaskId: extra.remoteTaskId,
        error: extra.error,
      }),
    );
  } catch {
    // Intentional best-effort degradation; see the doc comment above.
  }
}

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
  const accountScope = deps.getAccountScope?.();

  type Claim =
    | { kind: "skipped"; reason: ExecuteScheduledTaskSkipReason; task: ScheduledTask }
    | { kind: "leased"; task: ScheduledTask };

  let claim: Claim | undefined;
  await mutateScheduledTasks(storage, (current) => {
    const latest = current.find((item) => item.id === taskId);
    if (!latest) throw new Error(i18nText(`未找到定时任务：${taskId}`, `Scheduled task not found: ${taskId}`));
    const executionKey = makeExecutionKey(latest);

    if (isFreshLease(latest, now, staleMs)) {
      claim = { kind: "skipped", reason: "in-flight", task: latest };
      return current;
    }

    const manualLegacyRun = force && deps.trigger === "cli" && deps.allowLegacyOwner === true
      && (!latest.owner || latest.owner.key === LEGACY_SCHEDULED_TASK_OWNER_KEY);
    const mismatch = accountScope && !manualLegacyRun && scheduledTaskOwnerMismatch(latest, accountScope);
    if (mismatch) {
      const reviewed = holdScheduledTaskForReview(latest, mismatch.reason, now);
      claim = { kind: "skipped", reason: "not-runnable", task: reviewed };
      return updateScheduledTask(current, reviewed);
    }

    if (latest.status === "running") {
      const reviewed: ScheduledTask = {
        ...latest,
        status: "needs_review",
        lastError:
          latest.lastRemoteTaskId && latest.executionKey
            ? i18nText(
                `远程创建后租约已过期（${latest.lastRemoteTaskId}）；重放前请先确认。`,
                `Lease expired after remote create (${latest.lastRemoteTaskId}); confirm before replaying.`,
              )
            : i18nText("运行期间租约已过期；结果未知，重放前请先确认。", "Lease expired while running; result unknown — confirm before replaying."),
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

  if (!claim) throw new Error(i18nText(`未找到定时任务：${taskId}`, `Scheduled task not found: ${taskId}`));
  if (claim.kind === "skipped") {
    return { skipped: true, reason: claim.reason, task: claim.task };
  }

  const leased = claim.task;
  const trigger: ExecutionTrigger = deps.trigger ?? "schedule";
  // Ledger timestamps use the real wall clock, not `deps.now`: `deps.now` is a
  // test seam for the scheduling domain (lease staleness, recurrence math) and
  // a backdated value would make the entry look older than the retention window.
  const startedAt = new Date().toISOString();
  try {
    const releaseAdjustedPayload = applyScheduledReleasePolicy(leased.payload, leased.scheduleTime);
    const prepared = deps.preparePayload ? await deps.preparePayload(releaseAdjustedPayload) : releaseAdjustedPayload;
    if (accountScope && deps.getAccountScope?.().key !== accountScope.key) {
      const reviewed = holdScheduledTaskForReview(leased, i18nText(
        "准备执行期间账号已切换，未提交实例创建。请确认账号后恢复计划。",
        "The account changed while preparing this run; no instance was submitted. Confirm the account and resume the plan.",
      ));
      await tryPersistTaskState(storage, reviewed);
      return { skipped: true, reason: "not-runnable", task: reviewed };
    }
    const result = await deps.createTask(prepared);
    const remoteTaskId = extractRemoteTaskId(result);

    // The remote task now exists. Everything below is local bookkeeping; a
    // failure here must never lead to another remote create.
    const withRemote: ScheduledTask = {
      ...leased,
      lastRemoteTaskId: remoteTaskId,
      lastRunAt: now.toISOString(),
    };
    try {
      const completed = await persistCompletionWithRetry(storage, withRemote, now, deps);
      await recordExecutionOutcome(storage, leased, trigger, startedAt, "completed", { remoteTaskId, accountScope });
      return { skipped: false, outcome: "completed", task: completed, remoteTaskId, result };
    } catch (persistError) {
      const review = persistFailureReview(withRemote, persistError, now);
      await tryPersistTaskState(storage, review);
      await recordExecutionOutcome(storage, leased, trigger, startedAt, "local-persist-failed", {
        remoteTaskId,
        accountScope,
        error: errorMessageOf(persistError),
      });
      return { skipped: false, outcome: "local-persist-failed", task: review, remoteTaskId, result };
    }
  } catch (error) {
    // createTask itself failed. Network-level failures may have reached the
    // server (outcome unknown): park in needs_review instead of failed so no
    // automatic replay can duplicate a remote create.
    const networkFailed = isNetworkError(error);
    const failed = networkFailed
      ? unknownOutcomeReview(leased, error, now)
      : failScheduledExecution(leased, error instanceof Error ? error.message : String(error), now);
    await tryPersistTaskState(storage, failed);
    await recordExecutionOutcome(storage, leased, trigger, startedAt, networkFailed ? "unknown" : "failed", {
      accountScope,
      error: errorMessageOf(error),
    });
    throw error;
  }
}
