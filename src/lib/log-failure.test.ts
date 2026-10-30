import { describe, expect, it } from "vitest";

import { summarizeLogFailure } from "./log-failure";

describe("summarizeLogFailure", () => {
  it("prefers the exception line over earlier error-looking lines and keeps the exit code", () => {
    const log = [
      "step 100 loss=1.2",
      "warning: error budget low",
      "Traceback (most recent call last):",
      '  File "train.py", line 211, in <module>',
      "RuntimeError: CUDA out of memory. Tried to allocate 2.00 GiB",
      "process exited with code 137",
    ].join("\n");

    expect(summarizeLogFailure(log)).toEqual({
      index: 4,
      line: "RuntimeError: CUDA out of memory. Tried to allocate 2.00 GiB",
      exitCode: "137",
    });
  });

  it("returns null for a clean or empty log", () => {
    expect(summarizeLogFailure("")).toBeNull();
    expect(summarizeLogFailure("step 1\nstep 2\ndone")).toBeNull();
  });
});
