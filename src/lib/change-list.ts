import { getActiveAccountScope } from "./account-scope";
import type { BatchItemStatus } from "./batch-runner";
import { updateStorageValue } from "./storage-mutex";
import type { RuntimeStorage } from "./types";

/**
 * Local change list for batch operations (release / delete / create / template
 * apply). Every completed batch — from the UI or from the CLI/MCP wrappers —
 * lands one record here with per-item outcomes, so a mixed batch can be
 * reviewed after the fact and its failed subset retried. Mirrors the storage
 * and validation model of `execution-ledger.ts`.
 */
export const BATCH_OPERATIONS_STORAGE_KEY = "easy-console.batchOperations";
export const DEFAULT_BATCH_OPERATIONS_LIMIT = 100;
export const DEFAULT_BATCH_OPERATIONS_RETENTION_DAYS = 30;

/** Which batch mutation produced the record. */
export type BatchOperationAction = "release" | "delete" | "create" | "template-apply";

/** Who started the batch: the desktop UI or the CLI/MCP wrapper. */
export type BatchOperationTrigger = "ui" | "cli";

export type BatchOperationItem = {
  /** Stable per-batch item key (remote task id, template ordinal, ...). */
  key: string;
  name: string;
  status: BatchItemStatus;
  error?: string;
  remoteTaskId?: string;
};

/** Manual resolution of an `unknown` item, mirroring the execution ledger. */
export type BatchItemResolutionStatus = "confirmed-created" | "confirmed-not-created";

export type BatchItemResolution = {
  key: string;
  status: BatchItemResolutionStatus;
  /** Remote task id captured by the verification, when one was found. */
  remoteTaskId?: string;
};

export type BatchOperationRecord = {
  /** `crypto.randomUUID()` — stable identity for retry linking. */
  id: string;
  action: BatchOperationAction;
  trigger: BatchOperationTrigger;
  /** Account-scope key of the account the batch belongs to; never contains secrets. */
  accountKey: string;
  accountDisplayName: string;
  /** ISO timestamp of the batch start. */
  startedAt: string;
  /** ISO timestamp of the batch finish. */
  finishedAt?: string;
  items: BatchOperationItem[];
  summary: { total: number; succeeded: number; failed: number; skipped: number; unknown: number };
  /** Id of the record this retry batch was re-run from. */
  retryOf?: string;
};

export type BatchOperationRecordInput = Omit<BatchOperationRecord, "id" | "accountKey" | "accountDisplayName"> & {
  id?: string;
  accountKey?: string;
  accountDisplayName?: string;
};

export type BatchOperationStoreOptions = {
  limit?: number;
  retentionDays?: number;
  now?: () => Date;
};

const BATCH_OPERATION_ACTIONS: readonly BatchOperationAction[] = ["release", "delete", "create", "template-apply"];
const BATCH_OPERATION_TRIGGERS: readonly BatchOperationTrigger[] = ["ui", "cli"];
const BATCH_ITEM_STATUSES: readonly BatchItemStatus[] = ["pending", "running", "succeeded", "failed", "skipped", "unknown"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseBatchOperationItem(raw: unknown): BatchOperationItem | null {
  if (!isRecord(raw)) return null;
  const key = stringValue(raw.key);
  const name = stringValue(raw.name);
  const status = BATCH_ITEM_STATUSES.includes(raw.status as BatchItemStatus) ? (raw.status as BatchItemStatus) : null;
  if (!key || !name || !status) return null;
  return {
    key,
    name,
    status,
    error: stringValue(raw.error),
    remoteTaskId: stringValue(raw.remoteTaskId),
  };
}

function summarizeItems(items: BatchOperationItem[]): BatchOperationRecord["summary"] {
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let unknown = 0;
  for (const item of items) {
    if (item.status === "succeeded") succeeded += 1;
    else if (item.status === "failed") failed += 1;
    else if (item.status === "skipped") skipped += 1;
    else if (item.status === "unknown") unknown += 1;
  }
  return { total: items.length, succeeded, failed, skipped, unknown };
}

/**
 * Validate one stored record. Records missing or corrupting the audit-critical
 * fields (id, action, trigger, account, start time, items) are dropped on
 * load; a broken item degrades to being dropped from its record, and a broken
 * summary is recomputed from the surviving items. Mirrors
 * `normalizeExecutionLedgerEntry`.
 */
export function normalizeBatchOperationRecord(raw: unknown): BatchOperationRecord | null {
  if (!isRecord(raw)) return null;
  const id = stringValue(raw.id);
  const accountKey = stringValue(raw.accountKey);
  const startedAt = stringValue(raw.startedAt);
  const action = BATCH_OPERATION_ACTIONS.includes(raw.action as BatchOperationAction) ? (raw.action as BatchOperationAction) : null;
  const trigger = BATCH_OPERATION_TRIGGERS.includes(raw.trigger as BatchOperationTrigger) ? (raw.trigger as BatchOperationTrigger) : null;
  if (!id || !accountKey || !startedAt || !action || !trigger) return null;
  if (Number.isNaN(Date.parse(startedAt))) return null;
  if (!Array.isArray(raw.items)) return null;

  const items = raw.items.map(parseBatchOperationItem).filter((item): item is BatchOperationItem => Boolean(item));
  const finishedAt = stringValue(raw.finishedAt);
  return {
    id,
    action,
    trigger,
    accountKey,
    accountDisplayName: stringValue(raw.accountDisplayName) ?? "",
    startedAt,
    finishedAt: finishedAt !== undefined && !Number.isNaN(Date.parse(finishedAt)) ? finishedAt : undefined,
    items,
    summary: summarizeItems(items),
    retryOf: stringValue(raw.retryOf),
  };
}

export function parseBatchOperations(raw: string | null): BatchOperationRecord[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeBatchOperationRecord).filter((item): item is BatchOperationRecord => Boolean(item));
  } catch {
    return [];
  }
}

/** Newest first by `startedAt`; the sort is stable so same-millisecond appends keep insertion order. */
export function sortBatchOperationRecords(items: BatchOperationRecord[]) {
  return [...items].sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
}

export function pruneBatchOperations(items: BatchOperationRecord[], options: BatchOperationStoreOptions = {}) {
  const limit = options.limit ?? DEFAULT_BATCH_OPERATIONS_LIMIT;
  const retentionDays = options.retentionDays ?? DEFAULT_BATCH_OPERATIONS_RETENTION_DAYS;
  const now = options.now?.() ?? new Date();
  const minTime = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;

  return sortBatchOperationRecords(
    items.filter((item) => {
      const startedTime = Date.parse(item.startedAt);
      return Number.isFinite(startedTime) && startedTime >= minTime;
    }),
  ).slice(0, limit);
}

/** Stamp the record with a `crypto.randomUUID()` id and the active account when the caller did not provide them. */
export function createBatchOperationRecord(input: BatchOperationRecordInput): BatchOperationRecord {
  const account = activeBatchOperationAccount();
  return {
    ...input,
    id: input.id ?? globalThis.crypto?.randomUUID?.() ?? `batch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    accountKey: input.accountKey ?? account.accountKey,
    accountDisplayName: input.accountDisplayName ?? account.accountDisplayName,
  };
}

/** Account identity for a new record: the active account scope, never secrets. */
export function activeBatchOperationAccount(): Pick<BatchOperationRecord, "accountKey" | "accountDisplayName"> {
  const scope = getActiveAccountScope();
  return { accountKey: scope.key, accountDisplayName: scope.displayName };
}

export async function listBatchOperations(
  storage: RuntimeStorage,
  options: BatchOperationStoreOptions = {},
): Promise<BatchOperationRecord[]> {
  return pruneBatchOperations(parseBatchOperations(await storage.get(BATCH_OPERATIONS_STORAGE_KEY)), options);
}

export async function appendBatchOperation(
  storage: RuntimeStorage,
  record: BatchOperationRecord,
  options: BatchOperationStoreOptions = {},
): Promise<void> {
  await updateStorageValue(storage, BATCH_OPERATIONS_STORAGE_KEY, (raw) => {
    const current = pruneBatchOperations(parseBatchOperations(raw), options);
    return JSON.stringify(pruneBatchOperations([record, ...current], options));
  });
}

/**
 * Revise a stored record in place (keeping its id and position) — used to land
 * manual resolutions of `unknown` items. Returns null when the id is gone.
 */
export async function updateBatchOperation(
  storage: RuntimeStorage,
  id: string,
  updater: (record: BatchOperationRecord) => BatchOperationRecord,
  options: BatchOperationStoreOptions = {},
): Promise<BatchOperationRecord | null> {
  let updated: BatchOperationRecord | null = null;
  await updateStorageValue(storage, BATCH_OPERATIONS_STORAGE_KEY, (raw) => {
    const current = pruneBatchOperations(parseBatchOperations(raw), options);
    const next = current.map((record) => {
      if (record.id !== id) return record;
      updated = updater(record);
      return updated;
    });
    return JSON.stringify(pruneBatchOperations(next, options));
  });
  return updated;
}

/**
 * Apply manual resolutions to a record's `unknown` items: confirmed-created
 * items become `succeeded` (capturing the verified remote id), confirmed-
 * not-created items become `failed` so the existing retry-failed path can pick
 * them up. Items without a resolution keep their status.
 */
export function applyBatchItemResolutions(
  record: BatchOperationRecord,
  resolutions: Map<string, BatchItemResolution>,
): BatchOperationRecord {
  if (!record.items.some((item) => item.status === "unknown" && resolutions.has(item.key))) return record;
  const items = record.items.map((item) => {
    const resolution = resolutions.get(item.key);
    if (!resolution || item.status !== "unknown") return item;
    if (resolution.status === "confirmed-created") {
      return {
        ...item,
        status: "succeeded" as const,
        error: undefined,
        ...(resolution.remoteTaskId && !item.remoteTaskId ? { remoteTaskId: resolution.remoteTaskId } : {}),
      };
    }
    return { ...item, status: "failed" as const };
  });
  return { ...record, items, summary: summarizeItems(items) };
}
