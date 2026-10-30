import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { clearIdleInstances, idleInstanceKey, publishIdleInstances, useIdleEvidence } from "./idle-instance-state";

describe("idle instance state", () => {
  afterEach(() => {
    act(() => clearIdleInstances());
  });

  it("keys instances by id, falling back to task_id", () => {
    expect(idleInstanceKey({ id: 7, task_id: "t-7" })).toBe("7");
    expect(idleInstanceKey({ id: undefined as never, task_id: "t-7" })).toBe("t-7");
  });

  it("shows an instance as idle until the watcher stops publishing it", () => {
    const { result } = renderHook(() => useIdleEvidence({ id: 7 }));
    expect(result.current).toBeNull();

    act(() => publishIdleInstances(new Map([["7", "gpu"]])));
    expect(result.current).toBe("gpu");

    act(() => publishIdleInstances(new Map([["8", "heuristic"]])));
    expect(result.current).toBeNull();
  });

  it("does not re-render readers when the published set is unchanged", () => {
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useIdleEvidence({ id: 7 });
    });
    act(() => publishIdleInstances(new Map([["7", "heuristic"]])));
    const afterChange = renders;

    act(() => publishIdleInstances(new Map([["7", "heuristic"]])));
    expect(renders).toBe(afterChange);
  });
});
