/**
 * Generic sequential batch execution engine shared by the web UI and the
 * CLI/MCP sidecars. Pure TypeScript: no DOM, Tauri, or Node APIs, so both the
 * renderer and the Node tools can reuse the same item/progress/summary model.
 *
 * The engine never rejects because of an item failure or an abort — every item
 * lands a terminal outcome (`succeeded` / `failed` / `skipped`) so callers can
 * render a complete change list and retry the failed subset.
 */

export type BatchItemStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export type BatchItemOutcome<TItem, TResult = unknown> = {
  item: TItem;
  status: BatchItemStatus;
  error?: string;
  result?: TResult;
};

export type BatchRunOptions<TItem, TResult> = {
  run: (item: TItem, index: number) => Promise<TResult>;
  /** Pause between items; the first item starts immediately. Defaults to 350ms, `0` disables. */
  delayMs?: number;
  /** Record the failure and keep going. Defaults to true; when false the remaining items become `skipped`. */
  continueOnError?: boolean;
  /** Once aborted, every item that has not started yet becomes `skipped`; the whole run still resolves. */
  signal?: AbortSignal;
  /** Called once per settled item with the accumulated outcomes snapshot and the item that just settled. */
  onProgress?: (outcomes: BatchItemOutcome<TItem, TResult>[], current: BatchItemOutcome<TItem, TResult>) => void;
};

export type BatchRunResult<TItem, TResult = unknown> = {
  outcomes: BatchItemOutcome<TItem, TResult>[];
  summary: { total: number; succeeded: number; failed: number; skipped: number };
};

export const DEFAULT_BATCH_DELAY_MS = 350;

function outcomeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function summarize<TItem, TResult>(outcomes: BatchItemOutcome<TItem, TResult>[]): BatchRunResult<TItem, TResult>["summary"] {
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  for (const outcome of outcomes) {
    if (outcome.status === "succeeded") succeeded += 1;
    else if (outcome.status === "failed") failed += 1;
    else if (outcome.status === "skipped") skipped += 1;
  }
  return { total: outcomes.length, succeeded, failed, skipped };
}

export async function runBatch<TItem, TResult = unknown>(
  items: readonly TItem[],
  options: BatchRunOptions<TItem, TResult>,
): Promise<BatchRunResult<TItem, TResult>> {
  const delayMs = options.delayMs ?? DEFAULT_BATCH_DELAY_MS;
  const continueOnError = options.continueOnError ?? true;
  const outcomes: BatchItemOutcome<TItem, TResult>[] = [];

  const emit = (outcome: BatchItemOutcome<TItem, TResult>) => {
    outcomes.push(outcome);
    options.onProgress?.([...outcomes], outcome);
  };

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (options.signal?.aborted) {
      emit({ item, status: "skipped" });
      continue;
    }
    if (index > 0 && delayMs > 0) {
      await delay(delayMs);
      if (options.signal?.aborted) {
        emit({ item, status: "skipped" });
        continue;
      }
    }
    try {
      const result = await options.run(item, index);
      emit({ item, status: "succeeded", result });
    } catch (error) {
      emit({ item, status: "failed", error: outcomeError(error) });
      if (!continueOnError) {
        for (let rest = index + 1; rest < items.length; rest += 1) {
          emit({ item: items[rest], status: "skipped" });
        }
        return { outcomes, summary: summarize(outcomes) };
      }
    }
  }

  return { outcomes, summary: summarize(outcomes) };
}

/**
 * Re-run only the items whose previous outcome was `failed`, keeping their
 * original order. The returned result covers just the retried subset, so a
 * caller combining it with the previous run replaces those outcomes in place.
 */
export async function retryFailedBatchItems<TItem, TResult = unknown>(
  previous: BatchRunResult<TItem, TResult>,
  options: BatchRunOptions<TItem, TResult>,
): Promise<BatchRunResult<TItem, TResult>> {
  const failedItems = previous.outcomes.filter((outcome) => outcome.status === "failed").map((outcome) => outcome.item);
  return runBatch(failedItems, options);
}
