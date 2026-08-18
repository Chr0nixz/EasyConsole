import { describe, expect, it } from "vitest";

import {
  findMatchingPriceOptionId,
  normalizePriceOptions,
  normalizeResourceSpecs,
  parsePositivePrice,
} from "./resource-price";

describe("resource-price", () => {
  it("normalizes resource specs from nested payloads", () => {
    const specs = normalizeResourceSpecs({
      data: [
        { id: 1, name: "A100", cpu: 8, gpu: 1, memory: 32 },
        { id: "2", label: "CPU only", cpu: "4", memory: "16" },
      ],
    });

    expect(specs).toHaveLength(2);
    expect(specs[0]).toMatchObject({ id: 1, name: "A100", cpu: 8, gpu: 1, memory: 32 });
    expect(specs[1]).toMatchObject({ id: "2", name: "CPU only", cpu: 4, memory: 16 });
  });

  it("normalizes price options from arrays, wrappers, and primitives", () => {
    expect(normalizePriceOptions([1, "2.5", { id: "p3", name: "GPU", price: 3 }])).toEqual([
      { id: "price-1", label: "1", value: 1 },
      { id: "price-2.5", label: "2.5", value: 2.5 },
      { id: "p3", label: "GPU (3)", value: 3 },
    ]);
    expect(normalizePriceOptions({ list: [{ value: 4 }] })).toEqual([{ id: "price-4-0", label: "4", value: 4 }]);
    expect(normalizePriceOptions(null)).toEqual([]);
    expect(normalizePriceOptions({ broken: true })).toEqual([]);
  });

  it("skips non-positive prices and matches existing values", () => {
    const options = normalizePriceOptions([{ price: 0 }, { price: -1 }, { price: 5 }]);
    expect(options).toEqual([{ id: "price-5-2", label: "5", value: 5 }]);
    expect(findMatchingPriceOptionId(options, 5)).toBe("price-5-2");
    expect(findMatchingPriceOptionId(options, "5")).toBe("price-5-2");
    expect(findMatchingPriceOptionId(options, 9)).toBe("");
  });

  it("parses positive price strings", () => {
    expect(parsePositivePrice("1.5")).toBe(1.5);
    expect(parsePositivePrice("0")).toBeNull();
    expect(parsePositivePrice("")).toBeNull();
  });
});
