import { describe, expect, it } from "vitest";

import { filterAndSortTasks } from "./task-search";
import type { Task } from "./types";

describe("task search", () => {
  it("ranks exact numeric task tokens before loose numeric matches", () => {
    const tasks = [
      { id: 1, name: "train-123" },
      { id: 2, name: "train-230" },
      { id: 23, name: "train-23" },
      { id: 4, name: "train-923" },
    ] satisfies Task[];

    expect(filterAndSortTasks(tasks, "23").map((task) => task.name)).toEqual(["train-23", "train-230", "train-123", "train-923"]);
  });

  it("does not match unrelated numeric fields such as IP addresses", () => {
    const tasks = [
      { id: 1, name: "alpha", ip: "10.0.0.23" },
      { id: 2, name: "job-23" },
    ] satisfies Task[];

    expect(filterAndSortTasks(tasks, "23").map((task) => task.name)).toEqual(["job-23"]);
  });
});
