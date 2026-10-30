import type { BatchItemOutcome } from "../../lib/batch-runner";
import type { BatchItemResolution } from "../../lib/change-list";
import { getTaskName } from "../../lib/format";
import type { Task } from "../../lib/types";
import type { PreviewItem } from "./BatchResultDialog";

/**
 * Verify `unknown` create outcomes against the live task list, mirroring the
 * execution ledger's matching rules: a task whose name matches and whose
 * creation time sits within the window around the batch start counts as
 * "created by this batch". Items that cannot be decided stay `unknown` for
 * manual review — they are never auto-flipped, because a wrong guess either
 * double-creates a billed instance or hides one that exists.
 */

const MATCH_WINDOW_MS = 30 * 60 * 1000;
const SCAN_PAGE_SIZE = 100;
/** Bound lookups; exhausting this budget leaves all items unknown. */
const SCAN_MAX_PAGES = 3;

export type VerifyUnknownItemsOptions = {
  /** ISO timestamp of the original batch start; the match window anchors here. */
  startedAt?: string;
  /** Fetch task-list pages; injected so tests stay offline. */
  listTasks: (query: { page: number; page_size: number }) => Promise<{ items: Task[]; total?: number }>;
};

function taskCreatedAt(task: Task) {
  const raw = String(task.create_time ?? task.created_at ?? "").trim();
  if (!raw) return Number.NaN;
  return Date.parse(raw.includes("T") ? raw : raw.replace(" ", "T"));
}

function remoteTaskId(task: Task) {
  const id = task.task_id ?? task.id;
  return id === undefined || id === null ? undefined : String(id);
}

async function scanTasks(options: VerifyUnknownItemsOptions): Promise<{ items: Task[]; complete: boolean }> {
  const items: Task[] = [];
  let expectedTotal = 0;
  for (let page = 1; page <= SCAN_MAX_PAGES; page += 1) {
    const result = await options.listTasks({ page, page_size: SCAN_PAGE_SIZE });
    items.push(...result.items);
    if (typeof result.total === "number" && Number.isFinite(result.total)) {
      expectedTotal = Math.max(expectedTotal, result.total);
    }
    if (result.items.length < SCAN_PAGE_SIZE) {
      // A short page normally ends the list, but a larger reported total
      // means rows are still missing (for example, a backend page-size cap).
      return { items, complete: items.length >= expectedTotal };
    }
  }
  return { items, complete: false };
}

/**
 * Resolutions for every decidable `unknown` outcome:
 * - exactly one in-window name match → `confirmed-created` (with the remote id);
 * - no in-window name match in a complete scan → `confirmed-not-created`;
 * - ambiguous matches (several, or an unreadable creation time) → omitted.
 *
 * An incomplete scan cannot establish absence or uniqueness, so it resolves
 * nothing. In particular, hitting the page limit never makes a create retryable.
 *
 * Returns nothing when the batch start time is unavailable: without that
 * anchor an old same-named task cannot be told apart from a fresh create, so
 * no "not created" verdict would be trustworthy.
 */
export async function verifyUnknownCreateItems(
  outcomes: BatchItemOutcome<PreviewItem>[],
  options: VerifyUnknownItemsOptions,
): Promise<BatchItemResolution[]> {
  const unknownOutcomes = outcomes.filter((outcome) => outcome.status === "unknown");
  if (unknownOutcomes.length === 0) return [];

  const started = options.startedAt ? Date.parse(options.startedAt) : Number.NaN;
  if (!Number.isFinite(started)) return [];

  const { items, complete } = await scanTasks(options);
  if (!complete) return [];

  const resolutions: BatchItemResolution[] = [];
  for (const outcome of unknownOutcomes) {
    const expectedName = outcome.item.name.trim();
    if (!expectedName) continue;
    const candidates = items.filter((task) => {
      const name = getTaskName(task);
      return name === expectedName || name.startsWith(expectedName);
    });
    // An undated same-named task could be this create or another candidate.
    // Ignoring it would incorrectly prove either absence or uniqueness.
    if (candidates.some((task) => !Number.isFinite(taskCreatedAt(task)))) continue;
    const matches = candidates.filter((task) => Math.abs(taskCreatedAt(task) - started) <= MATCH_WINDOW_MS);
    if (matches.length === 1) {
      resolutions.push({ key: outcome.item.key, status: "confirmed-created", remoteTaskId: remoteTaskId(matches[0]) });
    } else if (matches.length === 0) {
      resolutions.push({ key: outcome.item.key, status: "confirmed-not-created" });
    }
  }
  return resolutions;
}
