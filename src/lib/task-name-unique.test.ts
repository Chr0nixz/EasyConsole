import { describe, expect, it, vi } from "vitest";

import {
  allocateUniqueTaskNames,
  collectExistingTaskNames,
  createCombinedTaskNameAvailabilityChecker,
  createTaskNameAvailabilityChecker,
  createTakenNamesAvailabilityChecker,
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

describe("collectExistingTaskNames", () => {
  it("collects name and task_name fields", () => {
    expect(
      collectExistingTaskNames([
        { name: "a", task_name: "b" },
        { name: "  a  " },
        { task_name: "" },
      ]),
    ).toEqual(new Set(["a", "b"]));
  });
});

describe("isTaskNameAvailableResponse", () => {
  it("treats bare booleans as exists flags", () => {
    expect(isTaskNameAvailableResponse(true)).toBe(false);
    expect(isTaskNameAvailableResponse(false)).toBe(true);
    expect(isTaskNameAvailableResponse({ data: true })).toBe(false);
    expect(isTaskNameAvailableResponse({ data: false })).toBe(true);
  });

  it("parses explicit availability / exists shapes", () => {
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

  it("uses taken-name sets from the task list", () => {
    const isAvailable = createTakenNamesAvailabilityChecker(["demo", "demo_1"]);
    expect(isAvailable("demo")).toBe(false);
    expect(isAvailable("demo_1")).toBe(false);
    expect(isAvailable("demo_2")).toBe(true);
  });

  it("caches checkTaskName results", async () => {
    const check = vi.fn(async (name: string) => ({ available: name !== "a" }));
    const isAvailable = createTaskNameAvailabilityChecker(check);
    expect(await isAvailable("a")).toBe(false);
    expect(await isAvailable("a")).toBe(false);
    expect(await isAvailable("b")).toBe(true);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("lets the task list override a flaky available API response", async () => {
    const isAvailable = createCombinedTaskNameAvailabilityChecker({
      existingNames: ["job"],
      checkTaskName: async () => ({ available: true }),
    });
    expect(await isAvailable("job")).toBe(false);
    expect(await isAvailable("job_1")).toBe(true);
  });

  it("rewrites payload names from listed existing names", async () => {
    const payloads = await maybeAllocateUniqueCreateTaskNames([{ name: "job" }, { name: "job" }], {
      enabled: true,
      existingNames: ["job"],
    });
    expect(payloads.map((payload) => payload.name)).toEqual(["job_1", "job_2"]);
  });

  it("loads existing names via listExistingNames", async () => {
    const payloads = await maybeAllocateUniqueCreateTaskNames([{ name: "xxx" }], {
      enabled: true,
      listExistingNames: async () => ["xxx"],
    });
    expect(payloads[0]?.name).toBe("xxx_1");
  });

  it("leaves payload names unchanged when disabled", async () => {
    const payloads = await maybeAllocateUniqueCreateTaskNames([{ name: "job" }], {
      enabled: false,
      existingNames: ["job"],
    });
    expect(payloads).toEqual([{ name: "job" }]);
  });
});
