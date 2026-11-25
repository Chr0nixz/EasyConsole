import {
  canExtendRelease,
  formatReleaseTimeInput,
  getExtendedReleaseAt,
  parseReleaseTime,
} from "./task-release-notifications";
import type { Task } from "./types";

/** Why an extension was not sent. Nothing was written to the backend in any of these cases. */
export type ExtendReleaseRefusal = "missing" | "not-extendable" | "changed";

export class ExtendReleaseRefusedError extends Error {
  constructor(
    readonly reason: ExtendReleaseRefusal,
    /** The release time the backend reports now, when the instance was found. */
    readonly latestReleaseAt: number | null = null,
  ) {
    super(`Release extension refused: ${reason}`);
    this.name = "ExtendReleaseRefusedError";
  }
}

/**
 * How the written release time compared with what the backend reports right after:
 * `confirmed` within a minute, `mismatch` when it differs or is missing, and
 * `unchecked` when the task list could not be read back.
 */
export type ExtendReleaseVerification = "confirmed" | "mismatch" | "unchecked";

export type ExtendReleaseResult = {
  task: Task;
  releaseAt: number;
  releaceTime: string;
  verification: ExtendReleaseVerification;
  /** Release time the backend reported after the write; null when missing or unreadable. */
  backendReleaseAt: number | null;
};

export type ExtendReleaseDeps = {
  /** Fresh task list from the backend; the caller decides which query it reads. */
  loadTasks(): Promise<Task[]>;
  updateTask(id: string | number, payload: { releace_time: string }): Promise<unknown>;
  now?: () => number;
};

/** The backend stores release times to the second; allow a minute for coarser storage. */
const VERIFY_TOLERANCE_MS = 60_000;

function present(value: unknown) {
  return value !== undefined && value !== null && value !== "";
}

function sameTask(left: Task, right: Task) {
  if (present(left.id) && present(right.id)) return String(left.id) === String(right.id);
  return present(left.task_id) && String(left.task_id) === String(right.task_id);
}

/**
 * Extends a timed release from the instance's current state, never from the snapshot the
 * caller rendered: a snapshot taken before someone else extended the release would write an
 * earlier absolute time and release the instance early. When the backend's release time no
 * longer matches the snapshot the user looked at, nothing is written and the caller shows the
 * new time instead. After writing, the release time is read back so success is reported only
 * when the backend actually holds it.
 */
export async function extendTimedRelease(snapshot: Task, hours: number, deps: ExtendReleaseDeps): Promise<ExtendReleaseResult> {
  const now = deps.now ?? Date.now;
  const latest = (await deps.loadTasks()).find((item) => sameTask(snapshot, item));
  if (!latest) throw new ExtendReleaseRefusedError("missing");
  const latestReleaseAt = parseReleaseTime(latest);
  if (!canExtendRelease(latest)) throw new ExtendReleaseRefusedError("not-extendable", latestReleaseAt);
  if (latestReleaseAt !== parseReleaseTime(snapshot)) throw new ExtendReleaseRefusedError("changed", latestReleaseAt);

  const releaseAt = getExtendedReleaseAt(latest, hours, now());
  const releaceTime = formatReleaseTimeInput(new Date(releaseAt));
  await deps.updateTask(latest.id, { releace_time: releaceTime });

  let after: Task | undefined;
  try {
    after = (await deps.loadTasks()).find((item) => sameTask(snapshot, item));
  } catch {
    return { task: latest, releaseAt, releaceTime, verification: "unchecked", backendReleaseAt: null };
  }
  if (!after) return { task: latest, releaseAt, releaceTime, verification: "unchecked", backendReleaseAt: null };
  const backendReleaseAt = parseReleaseTime(after);
  const confirmed = backendReleaseAt !== null && Math.abs(backendReleaseAt - releaseAt) < VERIFY_TOLERANCE_MS;
  return { task: after, releaseAt, releaceTime, verification: confirmed ? "confirmed" : "mismatch", backendReleaseAt };
}
