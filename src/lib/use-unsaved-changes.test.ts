import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { confirmDiscardUnsavedChanges } from "./use-unsaved-changes";

describe("confirmDiscardUnsavedChanges", () => {
  const originalConfirm = window.confirm;

  beforeEach(() => {
    window.confirm = vi.fn();
  });

  afterEach(() => {
    window.confirm = originalConfirm;
  });

  it("forwards the confirm dialog result", () => {
    (window.confirm as ReturnType<typeof vi.fn>).mockReturnValue(true);
    expect(confirmDiscardUnsavedChanges("Leave?")).toBe(true);
    expect(window.confirm).toHaveBeenCalledWith("Leave?");

    (window.confirm as ReturnType<typeof vi.fn>).mockReturnValue(false);
    expect(confirmDiscardUnsavedChanges()).toBe(false);
  });
});
