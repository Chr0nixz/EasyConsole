import { describe, expect, it } from "vitest";

import { queryKeys } from "./query-keys";

describe("queryKeys", () => {
  it("shares image list/system keys across pages", () => {
    expect(queryKeys.images.list()).toEqual(["images", "list"]);
    expect(queryKeys.images.system()).toEqual(["images", "system"]);
    expect(queryKeys.images.all).toEqual(["images"]);
  });

  it("includes sort fields in task list keys", () => {
    expect(
      queryKeys.tasks.list({
        page: 2,
        pageSize: 50,
        keyword: "gpu",
        status: "2",
        sortBy: "name",
        sortDir: "asc",
      }),
    ).toEqual(["tasks", "list", 2, 50, "gpu", "2", "name", "asc"]);
  });
});
