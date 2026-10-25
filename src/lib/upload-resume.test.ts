import { beforeEach, describe, expect, it } from "vitest";

import {
  clearUploadResume,
  createThrottledCheckpointSaver,
  loadUploadResume,
  makeFileKey,
  saveUploadResume,
} from "./upload-resume";
import type { RuntimeStorage } from "./types";

function memoryStorage(): RuntimeStorage {
  const data = new Map<string, string>();
  return {
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, value) {
      data.set(key, value);
    },
    async remove(key) {
      data.delete(key);
    },
  };
}

const FILE_KEY = "big.bin-10485760-1700000000000";

describe("upload resume store", () => {
  let storage: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    storage = memoryStorage();
  });

  it("round-trips one record per file key", async () => {
    await saveUploadResume(storage, { fileKey: FILE_KEY, uploadId: "u-1", uploadedChunks: [0, 1, 2], createdAt: "2026-10-25T10:00:00.000Z" });
    expect(await loadUploadResume(storage, FILE_KEY)).toMatchObject({ uploadId: "u-1", uploadedChunks: [0, 1, 2] });
    expect(await loadUploadResume(storage, "other")).toBeNull();

    await clearUploadResume(storage, FILE_KEY);
    expect(await loadUploadResume(storage, FILE_KEY)).toBeNull();
    // Clearing an absent key is a harmless no-op for readers.
    await clearUploadResume(storage, "other");
    expect(await loadUploadResume(storage, "other")).toBeNull();
  });

  it("builds the file key from name, size, and lastModified", () => {
    const file = new File(["x"], "model.bin", { lastModified: 1234 });
    expect(makeFileKey(file)).toBe(`model.bin-1-1234`);
  });
});

describe("createThrottledCheckpointSaver", () => {
  let storage: ReturnType<typeof memoryStorage>;
  let clock: { now: number };

  beforeEach(() => {
    storage = memoryStorage();
    clock = { now: 10_000 };
  });

  function saver(minIntervalMs = 2000) {
    return createThrottledCheckpointSaver(storage, { fileKey: FILE_KEY, minIntervalMs, now: () => clock.now });
  }

  async function settled() {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("saves the first checkpoint immediately and later ones at most once per window", async () => {
    const handle = saver(2000);
    handle.save({ uploadId: "u-1", completedIndices: [0] });
    clock.now += 100;
    handle.save({ uploadId: "u-1", completedIndices: [0, 1] });
    clock.now += 100;
    handle.save({ uploadId: "u-1", completedIndices: [0, 1, 2] });
    await settled();
    // The two quick checkpoints were folded; the persisted state is the newest one.
    expect(await loadUploadResume(storage, FILE_KEY)).toMatchObject({ uploadId: "u-1", uploadedChunks: [0] });

    clock.now += 2000;
    handle.save({ uploadId: "u-1", completedIndices: [0, 1, 2] });
    await settled();
    expect(await loadUploadResume(storage, FILE_KEY)).toMatchObject({ uploadId: "u-1", uploadedChunks: [0, 1, 2] });
  });

  it("flush persists the latest checkpoint unconditionally", async () => {
    const handle = saver(60_000);
    handle.save({ uploadId: "u-1", completedIndices: [0] });
    await settled();
    handle.save({ uploadId: "u-1", completedIndices: [0, 1] });
    await settled();
    // The second checkpoint is inside the huge window, but flush forces it out.
    expect(await loadUploadResume(storage, FILE_KEY)).toMatchObject({ uploadedChunks: [0] });
    await handle.flush();
    expect(await loadUploadResume(storage, FILE_KEY)).toMatchObject({ uploadedChunks: [0, 1] });
  });

  it("flush is a no-op before any checkpoint arrived", async () => {
    const handle = saver();
    await handle.flush();
    expect(await loadUploadResume(storage, FILE_KEY)).toBeNull();
  });
});
