import { describe, expect, it } from "vitest";

import { composeMobileControl } from "./ssh-terminal-input";

describe("composeMobileControl", () => {
  it("passes input through untouched when the virtual Ctrl is not armed", () => {
    expect(composeMobileControl(false, "c")).toEqual({ send: "c", ctrlConsumed: false });
    expect(composeMobileControl(false, "\x1b[A")).toEqual({ send: "\x1b[A", ctrlConsumed: false });
  });

  it("composes a single letter into its C0 control character and consumes Ctrl", () => {
    expect(composeMobileControl(true, "c")).toEqual({ send: "\x03", ctrlConsumed: true });
    expect(composeMobileControl(true, "C")).toEqual({ send: "\x03", ctrlConsumed: true });
    expect(composeMobileControl(true, "z")).toEqual({ send: "\x1a", ctrlConsumed: true });
    expect(composeMobileControl(true, "d")).toEqual({ send: "\x04", ctrlConsumed: true });
    expect(composeMobileControl(true, "l")).toEqual({ send: "\x0c", ctrlConsumed: true });
  });

  it("keeps Ctrl armed for non-letter input so two-key chords keep working", () => {
    expect(composeMobileControl(true, "\x1b[A")).toEqual({ send: "\x1b[A", ctrlConsumed: false });
    expect(composeMobileControl(true, "1")).toEqual({ send: "1", ctrlConsumed: false });
    expect(composeMobileControl(true, "")).toEqual({ send: "", ctrlConsumed: false });
  });

  it("never double-sends: the raw letter is replaced, not duplicated", () => {
    const result = composeMobileControl(true, "c");
    expect(result.send).toBe("\x03");
    expect(result.send).not.toContain("c");
  });
});
