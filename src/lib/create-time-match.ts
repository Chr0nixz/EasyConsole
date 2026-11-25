import type { Task } from "./types";

/** How far from a create request's start an instance may have been created and still count as that create. */
export const CREATE_MATCH_WINDOW_MS = 30 * 60_000;

/**
 * Widest gap between two UTC offsets (UTC-12 to UTC+14). A creation time without a zone is
 * the server's wall clock read as this machine's, so when the two zones differ it can be off
 * by up to this much.
 */
export const MAX_ZONE_SKEW_MS = 26 * 3_600_000;

export type TaskCreatedAt = { at: number; zoned: boolean };

/** The instance's creation time, and whether its text named a zone; null when missing or unreadable. */
export function parseTaskCreatedAt(task: Pick<Task, "create_time" | "created_at">): TaskCreatedAt | null {
  const raw = String(task.create_time ?? task.created_at ?? "").trim();
  if (!raw) return null;
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T");
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return { at, zoned: /(?:z|[+-]\d{2}:?\d{2})$/i.test(iso) };
}

/**
 * Where an instance's creation time falls relative to a create request that started at `startedAt`:
 * - `inside`: within the match window, assuming the server and this machine share a zone
 *   (always true for a time that names its zone);
 * - `possible`: outside that window, but within it under some zone difference, so it may
 *   still be this create;
 * - `outside`: too far away to be this create under any zone.
 *
 * Only `outside` proves an instance is not this create, and only a lone `inside` with no
 * `possible` neighbour proves which one is.
 */
export function createTimeProximity(createdAt: TaskCreatedAt, startedAt: number): "inside" | "possible" | "outside" {
  const gap = Math.abs(createdAt.at - startedAt);
  if (gap <= CREATE_MATCH_WINDOW_MS) return "inside";
  if (!createdAt.zoned && gap <= CREATE_MATCH_WINDOW_MS + MAX_ZONE_SKEW_MS) return "possible";
  return "outside";
}
