import { describe, expect, it } from "vitest";

import {
  deleteResourcePreset,
  formatResourcePresetSummary,
  loadResourcePresets,
  parseResourcePresetValues,
  saveResourcePresets,
  upsertResourcePreset,
} from "./resource-presets";
import type { ResourcePreset, RuntimeStorage } from "./types";

function memoryStorage(): RuntimeStorage {
  const store = new Map<string, string>();
  return {
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
    },
    async remove(key) {
      store.delete(key);
    },
  };
}

const basePreset: ResourcePreset = {
  id: "preset-1",
  name: "开发机",
  cpu: 4,
  gpu: 1,
  memory: 16,
  createdAt: "2026-05-23T00:00:00.000Z",
  updatedAt: "2026-05-23T00:00:00.000Z",
};

describe("resource presets", () => {
  it("persists and reloads valid presets", async () => {
    const storage = memoryStorage();

    await saveResourcePresets(storage, [basePreset]);

    await expect(loadResourcePresets(storage)).resolves.toEqual([basePreset]);
  });

  it("returns an empty list for missing keys, broken JSON, and non-array payloads", async () => {
    const storage = memoryStorage();
    await expect(loadResourcePresets(storage)).resolves.toEqual([]);

    await storage.set("easy-console.resourcePresets", "{not json");
    await expect(loadResourcePresets(storage)).resolves.toEqual([]);

    await storage.set("easy-console.resourcePresets", JSON.stringify({ presets: [] }));
    await expect(loadResourcePresets(storage)).resolves.toEqual([]);
  });

  it("drops presets with invalid names or resource values", async () => {
    const storage = memoryStorage();
    await storage.set(
      "easy-console.resourcePresets",
      JSON.stringify([
        basePreset,
        { ...basePreset, id: "preset-2", name: "  " },
        { ...basePreset, id: "preset-3", cpu: 0 },
        { ...basePreset, id: "preset-4", gpu: 1.5 },
        { ...basePreset, id: "preset-5", memory: 0 },
        { ...basePreset, id: "preset-6", cpu: "not-a-number" },
        "nonsense",
      ]),
    );

    await expect(loadResourcePresets(storage)).resolves.toEqual([basePreset]);
  });

  it("accepts string resource values from stored payloads", async () => {
    const storage = memoryStorage();
    await storage.set(
      "easy-console.resourcePresets",
      JSON.stringify([{ ...basePreset, cpu: "8", gpu: "2", memory: "32" }]),
    );

    await expect(loadResourcePresets(storage)).resolves.toEqual([
      { ...basePreset, cpu: 8, gpu: 2, memory: 32 },
    ]);
  });

  it("drops duplicate names on load, keeping the first entry", async () => {
    const storage = memoryStorage();
    await storage.set(
      "easy-console.resourcePresets",
      JSON.stringify([
        { ...basePreset, id: "preset-a", name: "dev", cpu: 4 },
        { ...basePreset, id: "preset-b", name: " dev ", cpu: 8 },
        { ...basePreset, id: "preset-c", name: "训练机", cpu: 16 },
      ]),
    );

    const loaded = await loadResourcePresets(storage);
    expect(loaded.map((preset) => [preset.id, preset.cpu])).toEqual([
      ["preset-a", 4],
      ["preset-c", 16],
    ]);
  });

  it("prepends new presets and updates same-name presets in place", () => {
    const date = new Date("2026-06-01T00:00:00.000Z");

    const withNew = upsertResourcePreset([basePreset], { name: " 训练机 ", cpu: 8, gpu: 4, memory: 64 }, date);
    expect(withNew).toHaveLength(2);
    expect(withNew[0]).toMatchObject({ name: "训练机", cpu: 8, gpu: 4, memory: 64, createdAt: date.toISOString() });
    expect(withNew[1]).toBe(basePreset);

    const updated = upsertResourcePreset(withNew, { name: "开发机", cpu: 16, gpu: 0, memory: 32 }, date);
    expect(updated).toHaveLength(2);
    expect(updated[1]).toMatchObject({
      id: basePreset.id,
      name: "开发机",
      cpu: 16,
      gpu: 0,
      memory: 32,
      createdAt: basePreset.createdAt,
      updatedAt: date.toISOString(),
    });
  });

  it("ignores saves with an empty name", () => {
    expect(upsertResourcePreset([basePreset], { name: "   ", cpu: 8, gpu: 0, memory: 32 })).toEqual([basePreset]);
  });

  it("deletes presets by id", () => {
    expect(deleteResourcePreset([basePreset], basePreset.id)).toEqual([]);
    expect(deleteResourcePreset([basePreset], "missing")).toEqual([basePreset]);
  });

  it("parses form values with the create-task field rules", () => {
    expect(parseResourcePresetValues("4", "1", "16")).toEqual({ cpu: 4, gpu: 1, memory: 16 });
    expect(parseResourcePresetValues("0.5", "0", "1")).toEqual({ cpu: 0.5, gpu: 0, memory: 1 });

    expect(parseResourcePresetValues("0", "1", "16")).toBeNull();
    expect(parseResourcePresetValues("4", "-1", "16")).toBeNull();
    expect(parseResourcePresetValues("4", "1.5", "16")).toBeNull();
    expect(parseResourcePresetValues("4", "1", "0")).toBeNull();
    expect(parseResourcePresetValues("", "1", "16")).toBeNull();
    expect(parseResourcePresetValues("abc", "1", "16")).toBeNull();
  });

  it("formats the compact resource summary", () => {
    expect(formatResourcePresetSummary(basePreset)).toBe("4C / 1GPU / 16G");
    expect(formatResourcePresetSummary({ cpu: "8", gpu: 0, memory: 32 })).toBe("8C / 0GPU / 32G");
  });
});
