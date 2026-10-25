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
/** "Not created" verdicts scan a few pages so an item on page 2+ cannot flip a live create to retryable. */
const SCAN_MAX_PAGES = 3;

export type VerifyUnknownItemsOptions = {
  /** ISO timestamp of the original batch start; the match window anchors here. */
  startedAt?: string;
  /** Fetch task-list pages; injected so tests stay offline. */
  listTasks: (query: { page: number; page_size: number }) => Promise<{ items: Task[] }>;
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

async function scanTasks(options: VerifyUnknownItemsOptions): Promise<Task[]> {
  const items: Task[] = [];
  for (let page = 1; page <= SCAN_MAX_PAGES; page += 1) {
    const result = await options.listTasks({ page, page_size: SCAN_PAGE_SIZE });
    items.push(...result.items);
    if (result.items.length < SCAN_PAGE_SIZE) break;
  }
  return items;
}

/**
 * Resolutions for every decidable `unknown` outcome:
 * - exactly one in-window name match → `confirmed-created` (with the remote id);
 * - no name match anywhere in the scanned pages → `confirmed-not-created`;
 * - ambiguous matches (several, or an unreadable creation time) → omitted.
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

  const items = await scanTasks(options);
  const resolutions: BatchItemResolution[] = [];
  for (const outcome of unknownOutcomes) {
    const expectedName = outcome.item.name.trim();
    if (!expectedName) continue;
    const matches = items.filter((task) => {
      const name = getTaskName(task);
      if (name !== expectedName && !name.startsWith(expectedName)) return false;
      const created = taskCreatedAt(task);
      if (Number.isFinite(created) && Number.isFinite(started)) {
        return Math.abs(created - started) <= MATCH_WINDOW_MS;
      }
      // Unreadable timestamps cannot anchor the window; treat as no match so a
      // stale same-named task never confirms the create.
      return false;
    });
    if (matches.length === 1) {
      resolutions.push({ key: outcome.item.key, status: "confirmed-created", remoteTaskId: remoteTaskId(matches[0]) });
    } else if (matches.length === 0) {
      resolutions.push({ key: outcome.item.key, status: "confirmed-not-created" });
    }
  }
  return resolutions;
}
