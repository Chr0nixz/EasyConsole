import { describe, expect, it } from "vitest";

import {
  parseTaskListQuery,
  serializeTaskListQuery,
  sortTasksClientSide,
  taskMatchesQuery,
  toTaskApiQuery,
} from "./task-list-query";

describe("task list query", () => {
  it("parses and serializes non-default URL query state", () => {
    const state = parseTaskListQuery(
      new URLSearchParams("page=3&pageSize=100&keyword=demo&status=2&sortBy=name&sortDir=asc&user=alice&group=research&releaseCondition=1&deleted=false"),
    );

    expect(state).toMatchObject({
      page: 3,
      pageSize: 100,
      keyword: "demo",
      status: "2",
      sortBy: "name",
      sortDir: "asc",
    });
    expect(serializeTaskListQuery(state).toString()).toBe("page=3&pageSize=100&keyword=demo&status=2&sortBy=name&sortDir=asc");
  });

  it("builds backend query fields and keeps local fallback filters", () => {
    const state = parseTaskListQuery(new URLSearchParams("page=2&status=2&user=alice&group=gpu&releaseCondition=3&deleted=false"));

    expect(toTaskApiQuery(state)).toMatchObject({
      page: 2,
      page_size: 50,
      status: "2",
    });
    expect(
      taskMatchesQuery(
        {
          id: 1,
          status: 2,
          username: "alice",
          user_group: "gpu-team",
          releace_conditions: 3,
          is_delete: false,
        },
        state,
      ),
    ).toBe(true);
    expect(taskMatchesQuery({ id: 2, status: 6, username: "alice", user_group: "gpu" }, state)).toBe(false);
  });

  it("defaults sortDir to desc and omits sortDir in URL when desc", () => {
    const state = parseTaskListQuery(new URLSearchParams("sortBy=updated"));
    expect(state.sortBy).toBe("updated");
    expect(state.sortDir).toBe("desc");
    expect(serializeTaskListQuery(state).toString()).toBe("sortBy=updated");
  });

  it("sorts the current page client-side by name", () => {
    const sorted = sortTasksClientSide(
      [
        { id: 1, name: "beta" },
        { id: 2, name: "alpha" },
      ],
      "name",
      "asc",
    );
    expect(sorted.map((task) => task.name)).toEqual(["alpha", "beta"]);
  });

  it("sorts by billed cost and runtime, with missing values as zero", () => {
    const tasks = [
      { id: 1, cost: 12.5, use_time: 600 },
      { id: 2 },
      { id: 3, cost: 80, use_time: 30 },
    ];
    expect(sortTasksClientSide(tasks, "cost", "desc").map((task) => task.id)).toEqual([3, 1, 2]);
    expect(sortTasksClientSide(tasks, "duration", "asc").map((task) => task.id)).toEqual([2, 3, 1]);
    expect(parseTaskListQuery(new URLSearchParams("sortBy=cost")).sortBy).toBe("cost");
  });
});
