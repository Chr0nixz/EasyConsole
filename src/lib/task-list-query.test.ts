import { describe, expect, it } from "vitest";

import { parseTaskListQuery, serializeTaskListQuery, taskMatchesQuery, toTaskApiQuery } from "./task-list-query";

describe("task list query", () => {
  it("parses and serializes non-default URL query state", () => {
    const state = parseTaskListQuery(
      new URLSearchParams("page=3&pageSize=100&keyword=demo&status=2&user=alice&group=research&releaseCondition=1&deleted=false"),
    );

    expect(state).toMatchObject({
      page: 3,
      pageSize: 100,
      keyword: "demo",
      status: "2",
    });
    expect(serializeTaskListQuery(state).toString()).toBe("page=3&pageSize=100&keyword=demo&status=2");
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
});
