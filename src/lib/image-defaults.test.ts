import { describe, expect, it } from "vitest";

import { getLatestImage, pickDefaultImage } from "./image-defaults";
import type { ImageItem } from "./types";

describe("image defaults", () => {
  const older = { id: 3, name: "base", tag: "20240101" } as ImageItem;
  const newer = { id: 7, name: "train", tag: "20260101" } as ImageItem;

  it("starts new instance forms on the image the user set as default", () => {
    const chosen = { id: 2, name: "pinned", is_default: true } as ImageItem;
    expect(pickDefaultImage([older, newer, chosen])).toBe(chosen);
    expect(pickDefaultImage([older, { id: 4, isDefault: true } as ImageItem])?.id).toBe(4);
  });

  it("falls back to the newest image when none is marked default", () => {
    expect(pickDefaultImage([older, newer])).toBe(newer);
    expect(getLatestImage([newer, older])).toBe(newer);
    expect(pickDefaultImage([])).toBeNull();
  });
});
