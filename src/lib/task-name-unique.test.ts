import { describe, expect, it, vi } from "vitest";

import {
  allocateUniqueTaskNames,
  createTaskNameAvailabilityChecker,
  formatNumberedTaskName,
  isTaskNameAvailableResponse,
  maybeAllocateUniqueCreateTaskNames,
  nextUniqueTaskName,
} from "./task-name-unique";

describe("formatNumberedTaskName", () => {
  it("returns the base name for number 0", () => {
    expect(formatNumberedTaskName("XXX", 0)).toBe("XXX");
  });

  it("appends _N for positive numbers", () => {
    expect(formatNumberedTaskName("XXX", 1)).toBe("XXX_1");
    expect(formatNumberedTaskName("XXX", 12)).toBe("XXX_12");
  });

  it("trims the base name", () => {
    expect(formatNumberedTaskName("  job  ", 1)).toBe("job_1");
  });
});

describe("isTaskNameAvailableResponse", () => {
  it("parses common availability shapes", () => {
    expect(isTaskNameAvailableResponse(true)).toBe(true);
    expect(isTaskNameAvailableResponse(false)).toBe(false);
    expect(isTaskNameAvailableResponse({ available: true })).toBe(true);
    expect(isTaskNameAvailableResponse({ available: false })).toBe(false);
    expect(isTaskNameAvailableResponse({ exists: true })).toBe(false);
    expect(isTaskNameAvailableResponse({ exists: false })).toBe(true);
    expect(isTaskNameAvailableResponse({ isExist: true })).toBe(false);
    expect(isTaskNameAvailableResponse({ data: { available: false } })).toBe(false);
  });
});

describe("nextUniqueTaskName / allocateUniqueTaskNames", () => {
  it("keeps the base name when available", async () => {
    expect(await nextUniqueTaskName("XXX", async () => true)).toBe("XXX");
  });

  it("appends _1 when the base name is taken", async () => {
    const taken = new Set(["XXX"]);
    expect(await nextUniqueTaskName("XXX", async (name) => !taken.has(name))).toBe("XXX_1");
  });

  it("skips already numbered collisions", async () => {
    const taken = new Set(["job", "job_1", "job_2"]);
    expect(await nextUniqueTaskName("job", async (name) => !taken.has(name))).toBe("job_3");
  });

  it("allocates unique names across a batch without colliding with each other", async () => {
    const taken = new Set(["demo"]);
    const names = await allocateUniqueTaskNames(["demo", "demo", "other"], async (name) => !taken.has(name));
    expect(names).toEqual(["demo_1", "demo_2", "other"]);
  });

  it("rewrites payload names when enabled", async () => {
    const payloads = await maybeAllocateUniqueCreateTaskNames([{ name: "job" }, { name: "job" }], {
      enabled: true,
      checkTaskName: async (name) => ({ available: name !== "job" }),
    });
    expect(payloads.map((payload) => payload.name)).toEqual(["job_1", "job_2"]);
  });

  it("leaves payload names unchanged when disabled", async () => {
    const payloads = await maybeAllocateUniqueCreateTaskNames([{ name: "job" }], {
      enabled: false,
      checkTaskName: async () => ({ available: false }),
    });
    expect(payloads).toEqual([{ name: "job" }]);
  });
});
