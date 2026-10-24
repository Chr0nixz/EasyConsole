import { describe, expect, it } from "vitest";

import { claimOverlayKey, hasOpenModalOverlay, openOverlay } from "./overlay-stack";

describe("overlay stack", () => {
  it("lets only the topmost overlay claim a key, and only once", () => {
    const dialog = openOverlay("modal");
    const picker = openOverlay("modal");
    const escape = new Event("keydown");

    expect(claimOverlayKey(dialog, escape)).toBe(false);
    expect(claimOverlayKey(picker, escape)).toBe(true);

    // The picker closes while the same Escape is still dispatching: the dialog beneath is now
    // on top, but it must not answer that key a second time.
    picker.release();
    expect(dialog.isTop()).toBe(true);
    expect(claimOverlayKey(dialog, escape)).toBe(false);
    expect(claimOverlayKey(dialog, new Event("keydown"))).toBe(true);

    dialog.release();
  });

  it("counts modals, not popovers, as owning the keyboard", () => {
    const menu = openOverlay("popover");
    expect(hasOpenModalOverlay()).toBe(false);

    const dialog = openOverlay("modal");
    expect(hasOpenModalOverlay()).toBe(true);

    dialog.release();
    menu.release();
    expect(hasOpenModalOverlay()).toBe(false);
  });

  it("releases out of order without disturbing the rest of the stack", () => {
    const first = openOverlay("modal");
    const second = openOverlay("popover");
    const third = openOverlay("modal");

    second.release();
    second.release();
    expect(third.isTop()).toBe(true);

    third.release();
    expect(first.isTop()).toBe(true);
    first.release();
  });
});
