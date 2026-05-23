import { describe, expect, it } from "vitest";

import { formatContentRange } from "./api";

describe("storage upload", () => {
  it("formats content range headers", () => {
    expect(formatContentRange({ start: 0, end: 1023, total: 4096 })).toBe("bytes 0-1023/4096");
  });
});
