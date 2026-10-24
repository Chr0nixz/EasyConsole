import { afterEach, describe, expect, it } from "vitest";

import { getUnseenTaskFailureCount, markTaskFailuresSeen, recordUnseenTaskFailure } from "./task-attention";

describe("task attention", () => {
  afterEach(() => markTaskFailuresSeen());

  it("counts each failed task once until it is seen", () => {
    recordUnseenTaskFailure("7");
    recordUnseenTaskFailure("7");
    recordUnseenTaskFailure("9");
    expect(getUnseenTaskFailureCount()).toBe(2);

    markTaskFailuresSeen("7");
    expect(getUnseenTaskFailureCount()).toBe(1);
  });

  it("clears every unseen failure when the list is opened", () => {
    recordUnseenTaskFailure("1");
    recordUnseenTaskFailure("2");
    markTaskFailuresSeen();
    expect(getUnseenTaskFailureCount()).toBe(0);
  });
});
