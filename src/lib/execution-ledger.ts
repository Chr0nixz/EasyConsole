import { getActiveAccountScope } from "./account-scope";
import { updateStorageValue } from "./storage-mutex";
import type { RuntimeStorage, ScheduledTask } from "./types";

/**
 * Local audit ledger for scheduled-task executions. Every run of a scheduled
 * task — including runs held without a remote attempt — lands one entry here so
 * the "result unknown, needs verification" cases survive restarts and can be
 * reconciled against the remote console later.
 */
export const EXECUTION_LEDGER_STORAGE_KEY = "easy-console.executionLedger";
export const DEFAULT_EXECUTION_LEDGER_LIMIT = 200;
export const DEFAULT_EXECUTION_LEDGER_RETENTION_DAYS = 30;

/** Who started the execution: the background schedule, a manual "Run now", or the CLI/MCP wrapper. */
export type ExecutionTrigger = "schedule" | "manual" | "cli";

/**
 * How an execution ended:
 * - `completed`: remote instance created and recorded locally.
 * - `local-persist-failed`: remote instance created, but the local completion write failed.
 * - `unknown`: network-level failure — the request may or may not have reached the server.
 * - `failed`: the remote API definitively rejected the create.
 * - `held-owner-mismatch`: held locally without a remote attempt because the owner did not match.
 */
export type ExecutionOutcome = "completed" | "local-persist-failed" | "unknown" | "failed" | "held-owner-mismatch";

/** Manual reconciliation outcome for `unknown` entries, recorded from the ledger UI. */
export type ExecutionResolution = {
  status: "confirmed-created" | "confirmed-not-created";
  resolvedAt: string;
  note?: string;
};

export type ExecutionLedgerEntry = {
  /** `crypto.randomUUID()` — stable identity for later resolution. */
  id: string;
  scheduledTaskId: string;
  scheduledTaskName: string;
  trigger: ExecutionTrigger;
  /** Account-scope key of the account the run belongs to; never contains secrets. */
  accountKey: string;
  accountDisplayName: string;
  /** ISO timestamp of the execution start (lease claim). */
  startedAt: string;
  /** ISO timestamp of the terminal outcome. */
  finishedAt?: string;
  remoteTaskId?: string;
  outcome: ExecutionOutcome;
  error?: string;
  resolution?: ExecutionResolution;
};

export type ExecutionLedgerEntryInput = Omit<ExecutionLedgerEntry, "id"> & { id?: string };

export type ExecutionLedgerStoreOptions = {
  limit?: number;
  retentionDays?: number;
  now?: () => Date;
};

const EXECUTION_TRIGGERS: readonly ExecutionTrigger[] = ["schedule", "manual", "cli"];
const EXECUTION_OUTCOMES: readonly ExecutionOutcome[] = [
  "completed",
  "local-persist-failed",
  "unknown",
  "failed",
  "held-owner-mismatch",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseResolution(raw: unknown): ExecutionResolution | undefined {
  if (!isRecord(raw)) return undefined;
  const status = raw.status;
  const resolvedAt = stringValue(raw.resolvedAt);
  if (resolvedAt === undefined || Number.isNaN(Date.parse(resolvedAt))) return undefined;
  if (status !== "confirmed-created" && status !== "confirmed-not-created") return undefined;
  return {
    status,
    resolvedAt,
    note: stringValue(raw.note),
  };
}

/**
 * Validate one stored entry. Entries missing or corrupting the audit-critical
 * fields (ids, times, outcome) are dropped on load; optional fields degrade
 * silently. This mirrors `normalizeRunLogEntry` in run-logs.ts.
 */
export function normalizeExecutionLedgerEntry(raw: unknown): ExecutionLedgerEntry | null {
  if (!isRecord(raw)) return null;
  const id = stringValue(raw.id);
  const scheduledTaskId = stringValue(raw.scheduledTaskId);
  const scheduledTaskName = stringValue(raw.scheduledTaskName);
  const accountKey = stringValue(raw.accountKey);
  const startedAt = stringValue(raw.startedAt);
  const trigger = EXECUTION_TRIGGERS.includes(raw.trigger as ExecutionTrigger) ? (raw.trigger as ExecutionTrigger) : null;
  const outcome = EXECUTION_OUTCOMES.includes(raw.outcome as ExecutionOutcome) ? (raw.outcome as ExecutionOutcome) : null;
  if (!id || !scheduledTaskId || !scheduledTaskName || !accountKey || !startedAt || !trigger || !outcome) return null;
  if (Number.isNaN(Date.parse(startedAt))) return null;

  const finishedAt = stringValue(raw.finishedAt);
  return {
    id,
    scheduledTaskId,
    scheduledTaskName,
    trigger,
    accountKey,
    accountDisplayName: stringValue(raw.accountDisplayName) ?? "",
    startedAt,
    finishedAt: finishedAt !== undefined && !Number.isNaN(Date.parse(finishedAt)) ? finishedAt : undefined,
    remoteTaskId: stringValue(raw.remoteTaskId),
    outcome,
    error: stringValue(raw.error),
    resolution: parseResolution(raw.resolution),
  };
}

export function parseExecutionLedger(raw: string | null): ExecutionLedgerEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeExecutionLedgerEntry).filter((item): item is ExecutionLedgerEntry => Boolean(item));
  } catch {
    return [];
  }
}

/** Newest first by `startedAt`; the sort is stable so same-millisecond appends keep insertion order. */
export function sortExecutionLedgerEntries(items: ExecutionLedgerEntry[]) {
  return [...items].sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
}

export function pruneExecutionLedger(items: ExecutionLedgerEntry[], options: ExecutionLedgerStoreOptions = {}) {
  const limit = options.limit ?? DEFAULT_EXECUTION_LEDGER_LIMIT;
  const retentionDays = options.retentionDays ?? DEFAULT_EXECUTION_LEDGER_RETENTION_DAYS;
  const now = options.now?.() ?? new Date();
  const minTime = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;

  return sortExecutionLedgerEntries(
    items.filter((item) => {
      const startedTime = Date.parse(item.startedAt);
      return Number.isFinite(startedTime) && startedTime >= minTime;
    }),
  ).slice(0, limit);
}

/** Stamp the entry with a `crypto.randomUUID()` id when the caller did not provide one. */
export function createExecutionLedgerEntry(input: ExecutionLedgerEntryInput): ExecutionLedgerEntry {
  return {
    ...input,
    id: input.id ?? globalThis.crypto?.randomUUID?.() ?? `execution-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  };
}

/** Account identity for a new entry: the active account scope, never secrets. */
export function activeExecutionAccount(): Pick<ExecutionLedgerEntry, "accountKey" | "accountDisplayName"> {
  const scope = getActiveAccountScope();
  return { accountKey: scope.key, accountDisplayName: scope.displayName };
}

/** An uncertain outcome nobody has reconciled yet: the remote instance may exist and bill. */
export function isPendingReviewEntry(entry: ExecutionLedgerEntry) {
  return !entry.resolution && (entry.outcome === "local-persist-failed" || entry.outcome === "unknown");
}

const ledgerChangeListeners = new Set<() => void>();

/** In-process change signal so counts (nav badge, dashboard) refresh as soon as this process writes the ledger. */
export function subscribeExecutionLedgerChanges(listener: () => void) {
  ledgerChangeListeners.add(listener);
  return () => {
    ledgerChangeListeners.delete(listener);
  };
}

function notifyExecutionLedgerChanged() {
  for (const listener of ledgerChangeListeners) listener();
}

export async function listExecutionLedger(
  storage: RuntimeStorage,
  options: ExecutionLedgerStoreOptions = {},
): Promise<ExecutionLedgerEntry[]> {
  return pruneExecutionLedger(parseExecutionLedger(await storage.get(EXECUTION_LEDGER_STORAGE_KEY)), options);
}

export async function appendExecutionLedgerEntry(
  storage: RuntimeStorage,
  entry: ExecutionLedgerEntry,
  options: ExecutionLedgerStoreOptions = {},
): Promise<void> {
  await updateStorageValue(storage, EXECUTION_LEDGER_STORAGE_KEY, (raw) => {
    const current = pruneExecutionLedger(parseExecutionLedger(raw), options);
    return JSON.stringify(pruneExecutionLedger([entry, ...current], options));
  });
  notifyExecutionLedgerChanged();
}

/** Attach a manual reconciliation result; returns the updated entry or undefined when the id is unknown. */
export async function resolveExecutionLedgerEntry(
  storage: RuntimeStorage,
  id: string,
  resolution: ExecutionResolution,
): Promise<ExecutionLedgerEntry | undefined> {
  let resolved: ExecutionLedgerEntry | undefined;
  await updateStorageValue(storage, EXECUTION_LEDGER_STORAGE_KEY, (raw) => {
    const current = parseExecutionLedger(raw);
    const next = current.map((item) => {
      if (item.id !== id) return item;
      resolved = { ...item, resolution };
      return resolved;
    });
    return JSON.stringify(next);
  });
  notifyExecutionLedgerChanged();
  return resolved;
}

/**
 * Record a schedule held for owner mismatch — no remote attempt was made. The
 * background runner calls this when it parks a mismatched row in needs_review.
 * Best-effort by design: a broken ledger must never interrupt the runner, so
 * write failures are swallowed here.
 */
export async function appendHeldOwnerMismatchEntry(
  storage: RuntimeStorage,
  task: Pick<ScheduledTask, "id" | "name">,
  reason: string,
  options: ExecutionLedgerStoreOptions & { trigger?: ExecutionTrigger } = {},
): Promise<void> {
  const now = (options.now?.() ?? new Date()).toISOString();
  try {
    await appendExecutionLedgerEntry(
      storage,
      createExecutionLedgerEntry({
        scheduledTaskId: task.id,
        scheduledTaskName: task.name,
        trigger: options.trigger ?? "schedule",
        ...activeExecutionAccount(),
        startedAt: now,
        finishedAt: now,
        outcome: "held-owner-mismatch",
        error: reason,
      }),
      options,
    );
  } catch {
    // Intentional best-effort degradation: the ledger is an audit trail, never
    // a participant in the scheduling flow.
  }
}
