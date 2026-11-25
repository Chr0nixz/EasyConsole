import { useCallback, useRef, useState } from "react";

import { getActiveAccountScope } from "../../lib/account-scope";
import { apiClient } from "../../lib/api";
import type { BatchItemOutcome, BatchRunResult } from "../../lib/batch-runner";
import { retryFailedBatchItems, runBatch } from "../../lib/batch-runner";
import {
  activeBatchOperationAccount,
  applyBatchItemResolutions,
  appendBatchOperation,
  createBatchOperationRecord,
  updateBatchOperation,
  type BatchItemResolution,
  type BatchOperationAction,
  type BatchOperationItem,
  type BatchOperationRecord,
} from "../../lib/change-list";
import { i18nText } from "../../lib/i18n-text";
import { extractRemoteTaskId } from "../../lib/schedule-execution";
import { browserRuntime } from "../../lib/runtime";
import type { PreviewItem } from "./BatchResultDialog";

/** Live summary over a growing outcomes list, with the total fixed up front. */
export function summarizeOutcomes(outcomes: BatchItemOutcome<PreviewItem>[], total?: number) {
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let unknown = 0;
  for (const outcome of outcomes) {
    if (outcome.status === "succeeded") succeeded += 1;
    else if (outcome.status === "failed") failed += 1;
    else if (outcome.status === "skipped") skipped += 1;
    else if (outcome.status === "unknown") unknown += 1;
  }
  return { total: total ?? outcomes.length, succeeded, failed, skipped, unknown };
}

/**
 * Outcomes → change-list items. Create results contribute their remote task
 * id extracted from the create response; callers operating on known remote ids
 * (release/delete) can pass `remoteTaskIdFromItem` to reuse the item key.
 */
export function changeListItemsFromOutcomes(
  outcomes: BatchItemOutcome<PreviewItem>[],
  remoteTaskIdFromItem?: (item: PreviewItem) => string | undefined,
): BatchOperationItem[] {
  return outcomes.map((outcome) => ({
    key: outcome.item.key,
    name: outcome.item.name,
    status: outcome.status,
    error: outcome.error,
    remoteTaskId: extractRemoteTaskId(outcome.result) ?? remoteTaskIdFromItem?.(outcome.item),
  }));
}

/**
 * Best-effort change-list persistence. The change list is an audit trail, never
 * a participant in the batch flow: append/revision failures are swallowed so a
 * storage hiccup can never leave the dialog stuck on "in progress" (same
 * policy as the execution ledger's recordExecutionOutcome).
 */
async function persistRecord(write: () => Promise<unknown>) {
  try {
    await write();
  } catch (error) {
    console.warn("Failed to persist the batch change-list record.", error);
  }
}

/**
 * The account and API session a batch started under. Items run through the shared API client,
 * so after a switch they would be created and billed under the other account; every item, and
 * every retry of the batch, checks this first. The token is compared too because switching
 * installs the new token before the account scope changes.
 */
type BatchSession = { accountKey: string; accountDisplayName: string; token: string | null; baseUrl: string };

function captureBatchSession(): BatchSession {
  return { ...activeBatchOperationAccount(), token: apiClient.getToken(), baseUrl: apiClient.getBaseUrl() };
}

function sessionChangedReason(session: BatchSession): string | undefined {
  const same =
    getActiveAccountScope().key === session.accountKey &&
    apiClient.getToken() === session.token &&
    apiClient.getBaseUrl() === session.baseUrl;
  return same ? undefined : i18nText("发起这次批量操作的账号已切换，未执行", "Not run: the account that started this batch was switched");
}

export type BatchOperationState = {
  action: BatchOperationAction;
  result: BatchRunResult<PreviewItem>;
  pending: boolean;
  /** Change-list record of the latest finished run; absent while pending. */
  record?: BatchOperationRecord;
  /** Every change-list record landed in this dialog session (original run + retries), oldest first. */
  records: BatchOperationRecord[];
};

export type StartBatchOperationArgs = {
  action: BatchOperationAction;
  items: PreviewItem[];
  run: (item: PreviewItem, index: number) => Promise<unknown>;
  /** Remote id known up front for an item (release/delete); create flows omit it. */
  remoteTaskIdFromItem?: (item: PreviewItem) => string | undefined;
  /** Change-list id this run retries; set when re-running a failed subset. */
  retryOf?: string;
  /** Called once per finished run with the full result and its ledger record. */
  onSettled?: (result: BatchRunResult<PreviewItem>, record: BatchOperationRecord) => void;
};

/**
 * Shared orchestration for in-app batch operations (review 6.3): runs items
 * sequentially with live progress, lands one change-list record per finished
 * run, and retries only the failed subset (linked via `retryOf`). Failed items
 * never interrupt the run — `runBatch` keeps going and every item settles.
 */
export function useBatchOperation() {
  const [state, setState] = useState<BatchOperationState | null>(null);
  const stateRef = useRef<BatchOperationState | null>(null);
  const runRef = useRef<StartBatchOperationArgs["run"] | null>(null);
  const sessionRef = useRef<BatchSession | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const update = useCallback((next: BatchOperationState | null) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const start = useCallback(
    async (args: StartBatchOperationArgs) => {
      const { action, items, run } = args;
      runRef.current = run;
      const session = captureBatchSession();
      sessionRef.current = session;
      const startedAt = new Date().toISOString();
      update({ action, result: { outcomes: [], summary: { total: items.length, succeeded: 0, failed: 0, skipped: 0, unknown: 0 } }, pending: true, records: [] });
      const controller = new AbortController();
      abortRef.current = controller;
      const result = await runBatch(items, {
        run,
        signal: controller.signal,
        haltReason: () => sessionChangedReason(session),
        onProgress: (outcomes) => {
          if (stateRef.current) {
            update({ ...stateRef.current, result: { outcomes, summary: summarizeOutcomes(outcomes, items.length) }, pending: true });
          }
        },
      });
      if (abortRef.current === controller) abortRef.current = null;
      const record = createBatchOperationRecord({
        action,
        trigger: "ui",
        startedAt,
        finishedAt: new Date().toISOString(),
        items: changeListItemsFromOutcomes(result.outcomes, args.remoteTaskIdFromItem),
        summary: result.summary,
        retryOf: args.retryOf,
        accountKey: session.accountKey,
        accountDisplayName: session.accountDisplayName,
      });
      await persistRecord(() => appendBatchOperation(browserRuntime.storage, record));
      update({ action, result, pending: false, record, records: [record] });
      args.onSettled?.(result, record);
      return { result, record };
    },
    [update],
  );

  /** Re-run only the failed items of the last run, merged back into the visible result. */
  const retryFailed = useCallback(
    async (args?: Pick<StartBatchOperationArgs, "onSettled">) => {
      const current = stateRef.current;
      const run = runRef.current;
      const session = sessionRef.current;
      if (!current || current.pending || !run || !session || current.result.summary.failed === 0) return undefined;
      const previous = current.result;
      const retryOutcomesByKey = new Map<string, BatchItemOutcome<PreviewItem>>();
      const startedAt = new Date().toISOString();
      const controller = new AbortController();
      abortRef.current = controller;
      const retryResult = await retryFailedBatchItems(previous, {
        run,
        signal: controller.signal,
        haltReason: () => sessionChangedReason(session),
        onProgress: (_outcomes, settled) => {
          retryOutcomesByKey.set(settled.item.key, settled);
          update({
            ...current,
            result: {
              outcomes: previous.outcomes.map((outcome) =>
                outcome.status === "failed" ? retryOutcomesByKey.get(outcome.item.key) ?? outcome : outcome,
              ),
              summary: summarizeOutcomes(
                previous.outcomes.map((outcome) =>
                  outcome.status === "failed" ? retryOutcomesByKey.get(outcome.item.key) ?? outcome : outcome,
                ),
              ),
            },
            pending: true,
          });
        },
      });
      if (abortRef.current === controller) abortRef.current = null;
      const mergedOutcomes = previous.outcomes.map((outcome) =>
        outcome.status === "failed" ? retryResult.outcomes.find((retry) => retry.item === outcome.item) ?? outcome : outcome,
      );
      const record = createBatchOperationRecord({
        action: current.action,
        trigger: "ui",
        startedAt,
        finishedAt: new Date().toISOString(),
        items: changeListItemsFromOutcomes(retryResult.outcomes),
        summary: retryResult.summary,
        retryOf: current.record?.id,
        accountKey: session.accountKey,
        accountDisplayName: session.accountDisplayName,
      });
      await persistRecord(() => appendBatchOperation(browserRuntime.storage, record));
      update({ action: current.action, result: { outcomes: mergedOutcomes, summary: summarizeOutcomes(mergedOutcomes) }, pending: false, record, records: [...current.records, record] });
      args?.onSettled?.(retryResult, record);
      return { result: retryResult, record };
    },
    [update],
  );

  /**
   * Land manual/verified resolutions of `unknown` items: confirmed-created
   * items become `succeeded`, confirmed-not-created items become `failed` (and
   * therefore retryable). Every record of this dialog session that still holds
   * a resolved item is revised in storage. Returns the updated result.
   */
  const resolveUnknown = useCallback(async (resolutions: BatchItemResolution[]) => {
    const current = stateRef.current;
    if (!current || current.pending || resolutions.length === 0) return undefined;
    const byKey = new Map(resolutions.map((resolution) => [resolution.key, resolution]));
    const applyToOutcome = (outcome: BatchItemOutcome<PreviewItem>) => {
      const resolution = byKey.get(outcome.item.key);
      if (!resolution || outcome.status !== "unknown") return outcome;
      if (resolution.status === "confirmed-created") {
        return { ...outcome, status: "succeeded" as const, error: undefined };
      }
      return { ...outcome, status: "failed" as const };
    };
    const outcomes = current.result.outcomes.map(applyToOutcome);
    const result: BatchRunResult<PreviewItem> = { outcomes, summary: summarizeOutcomes(outcomes) };
    const records = current.records.map((record) => applyBatchItemResolutions(record, byKey));
    const revisedCurrent = records.find((record) => record.id === current.record?.id);
    update({ ...current, result, records, record: revisedCurrent ?? current.record });
    for (let index = 0; index < records.length; index += 1) {
      if (records[index] !== current.records[index]) {
        const revised = records[index];
        await persistRecord(() => updateBatchOperation(browserRuntime.storage, revised.id, () => revised));
      }
    }
    return result;
  }, [update]);

  const clear = useCallback(() => update(null), [update]);

  /** Stop after the item in flight; every item not started yet settles as `skipped`. */
  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { state, start, retryFailed, resolveUnknown, clear, stop };
}
