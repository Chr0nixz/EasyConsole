import { useCallback, useRef, useState } from "react";

import type { BatchItemOutcome, BatchRunResult } from "../../lib/batch-runner";
import { retryFailedBatchItems, runBatch } from "../../lib/batch-runner";
import {
  appendBatchOperation,
  createBatchOperationRecord,
  type BatchOperationAction,
  type BatchOperationItem,
  type BatchOperationRecord,
} from "../../lib/change-list";
import { extractRemoteTaskId } from "../../lib/schedule-execution";
import { browserRuntime } from "../../lib/runtime";
import type { PreviewItem } from "./BatchResultDialog";

/** Live summary over a growing outcomes list, with the total fixed up front. */
export function summarizeOutcomes(outcomes: BatchItemOutcome<PreviewItem>[], total?: number) {
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  for (const outcome of outcomes) {
    if (outcome.status === "succeeded") succeeded += 1;
    else if (outcome.status === "failed") failed += 1;
    else if (outcome.status === "skipped") skipped += 1;
  }
  return { total: total ?? outcomes.length, succeeded, failed, skipped };
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
  const abortRef = useRef<AbortController | null>(null);

  const update = useCallback((next: BatchOperationState | null) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const start = useCallback(
    async (args: StartBatchOperationArgs) => {
      const { action, items, run } = args;
      runRef.current = run;
      const startedAt = new Date().toISOString();
      update({ action, result: { outcomes: [], summary: { total: items.length, succeeded: 0, failed: 0, skipped: 0 } }, pending: true, records: [] });
      const controller = new AbortController();
      abortRef.current = controller;
      const result = await runBatch(items, {
        run,
        signal: controller.signal,
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
      });
      await appendBatchOperation(browserRuntime.storage, record);
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
      if (!current || current.pending || !run || current.result.summary.failed === 0) return undefined;
      const previous = current.result;
      const retryOutcomesByKey = new Map<string, BatchItemOutcome<PreviewItem>>();
      const controller = new AbortController();
      abortRef.current = controller;
      const retryResult = await retryFailedBatchItems(previous, {
        run,
        signal: controller.signal,
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
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        items: changeListItemsFromOutcomes(retryResult.outcomes),
        summary: retryResult.summary,
        retryOf: current.record?.id,
      });
      await appendBatchOperation(browserRuntime.storage, record);
      update({ action: current.action, result: { outcomes: mergedOutcomes, summary: summarizeOutcomes(mergedOutcomes) }, pending: false, record, records: [...current.records, record] });
      args?.onSettled?.(retryResult, record);
      return { result: retryResult, record };
    },
    [update],
  );

  const clear = useCallback(() => update(null), [update]);

  /** Stop after the item in flight; every item not started yet settles as `skipped`. */
  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { state, start, retryFailed, clear, stop };
}
