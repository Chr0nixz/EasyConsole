import { describe, expect, it } from "vitest";

import {
  getTaskPinId,
  isTaskPinned,
  pruneTaskPins,
  sortTasksWithPins,
  toggleTaskPin,
} from "./task-pins";
import type { Task } from "./types";

const tasks = [
  { id: 1, name: "alpha" },
  { id: 2, task_id: "task-2", name: "beta" },
  { id: 3, name: "gamma" },
] as Task[];

describe("task pins", () => {
  it("uses task_id when available", () => {
    expect(getTaskPinId({ id: 1, task_id: "task-1" })).toBe("task-1");
    expect(getTaskPinId({ id: 1 })).toBe("1");
  });

  it("toggles pin state and keeps newest pin first", () => {
    expect(toggleTaskPin([], tasks[0])).toEqual(["1"]);
    expect(toggleTaskPin(["1"], tasks[0])).toEqual([]);
    expect(toggleTaskPin(["1"], tasks[1])).toEqual(["task-2", "1"]);
  });

  it("sorts pinned tasks ahead of unpinned tasks", () => {
    const sorted = sortTasksWithPins(tasks, ["3", "1"]);

    expect(sorted.map((task) => getTaskPinId(task))).toEqual(["3", "1", "task-2"]);
  });

  it("detects pinned tasks and prunes missing ids", () => {
    expect(isTaskPinned(["1", "3"], tasks[0])).toBe(true);
    expect(isTaskPinned(["3"], tasks[0])).toBe(false);
    expect(pruneTaskPins(["1", "9", "3"], tasks)).toEqual(["1", "3"]);
  });
});
