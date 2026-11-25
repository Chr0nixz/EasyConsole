import { describe, expect, it } from "vitest";

import {
  addTaskQuickAction,
  DEFAULT_TASK_QUICK_ACTIONS,
  loadTaskQuickActions,
  MAX_TASK_QUICK_ACTIONS,
  moveTaskQuickAction,
  normalizeTaskQuickActions,
  removeTaskQuickAction,
  saveTaskQuickActions,
  TASK_QUICK_ACTIONS_STORAGE_KEY,
  taskActionStripWidth,
} from "./task-quick-actions";
import type { RuntimeStorage } from "./types";

function memoryStorage(initial: Record<string, string> = {}): RuntimeStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, value) {
      data.set(key, value);
    },
    async remove(key) {
      data.delete(key);
    },
  };
}

describe("task quick actions", () => {
  it("sizes the action column for the bar it carries", () => {
    expect(taskActionStripWidth(0)).toBe(124);
    // The default three-button bar keeps the column's historical 232px.
    expect(taskActionStripWidth(DEFAULT_TASK_QUICK_ACTIONS.length)).toBe(232);
    expect(taskActionStripWidth(MAX_TASK_QUICK_ACTIONS)).toBe(340);
    // Out-of-range counts clamp instead of producing a column the bar cannot use.
    expect(taskActionStripWidth(-2)).toBe(124);
    expect(taskActionStripWidth(99)).toBe(340);
  });

  it("keeps known ids in saved order without repeats, capped at the maximum", () => {
    expect(normalizeTaskQuickActions(["clone", "nope", "log", "clone", 3, "terminal"])).toEqual(["clone", "log", "terminal"]);
    expect(normalizeTaskQuickActions(["terminal", "log", "monitor", "clone", "extend", "edit", "commit", "raw"])).toHaveLength(
      MAX_TASK_QUICK_ACTIONS,
    );
    // An empty bar is a choice; anything that is not a list is not.
    expect(normalizeTaskQuickActions([])).toEqual([]);
    expect(normalizeTaskQuickActions({ terminal: true })).toEqual(DEFAULT_TASK_QUICK_ACTIONS);
    expect(normalizeTaskQuickActions(null)).toEqual(DEFAULT_TASK_QUICK_ACTIONS);
  });

  it("loads the defaults when nothing or something unreadable is saved, and round-trips a choice", async () => {
    expect(await loadTaskQuickActions(memoryStorage())).toEqual(DEFAULT_TASK_QUICK_ACTIONS);
    expect(await loadTaskQuickActions(memoryStorage({ [TASK_QUICK_ACTIONS_STORAGE_KEY]: "{not json" }))).toEqual(
      DEFAULT_TASK_QUICK_ACTIONS,
    );

    const storage = memoryStorage();
    await saveTaskQuickActions(storage, ["raw", "log", "raw"]);
    expect(storage.data.get(TASK_QUICK_ACTIONS_STORAGE_KEY)).toBe(JSON.stringify(["raw", "log"]));
    expect(await loadTaskQuickActions(storage)).toEqual(["raw", "log"]);

    await saveTaskQuickActions(storage, []);
    expect(await loadTaskQuickActions(storage)).toEqual([]);
  });

  it("adds, removes and reorders without going past the ends or the maximum", () => {
    expect(addTaskQuickAction(["log"], "raw")).toEqual(["log", "raw"]);
    expect(addTaskQuickAction(["log"], "log")).toEqual(["log"]);
    const full = ["terminal", "log", "monitor", "clone", "extend", "edit"] as const;
    expect(addTaskQuickAction(full, "raw")).toEqual(full);

    expect(removeTaskQuickAction(["terminal", "log", "clone"], "log")).toEqual(["terminal", "clone"]);

    expect(moveTaskQuickAction(["terminal", "log", "clone"], "clone", -1)).toEqual(["terminal", "clone", "log"]);
    expect(moveTaskQuickAction(["terminal", "log", "clone"], "terminal", 1)).toEqual(["log", "terminal", "clone"]);
    expect(moveTaskQuickAction(["terminal", "log", "clone"], "terminal", -1)).toEqual(["terminal", "log", "clone"]);
    expect(moveTaskQuickAction(["terminal", "log", "clone"], "clone", 1)).toEqual(["terminal", "log", "clone"]);
    expect(moveTaskQuickAction(["terminal"], "raw", 1)).toEqual(["terminal"]);
  });
});
