import { describe, expect, it, vi } from "vitest";
import { releaseIdleInstance } from "./idle-auto-release";
import type { RuntimeStorage } from "./types";

function memory() {
  const data = new Map<string, string>();
  return {
    data,
    async get(key: string) { return data.get(key) ?? null; },
    async set(key: string, value: string) { data.set(key, value); },
    async remove(key: string) { data.delete(key); },
  };
}
const task = { id: 1, create_time: "2026-10-27T00:00:00Z" };

describe("idle auto-release intent", () => {
  it("allows exactly one concurrent attempt and keeps claims across restarts", async () => {
    const storage = memory();
    const release = vi.fn().mockResolvedValue({});
    const options = { storage, task, accountScope: "alice@lab", isCurrent: () => true, release };
    const outcomes = await Promise.all([releaseIdleInstance(options), releaseIdleInstance(options)]);
    expect(outcomes.sort()).toEqual(["released", "skipped"]);
    expect(await releaseIdleInstance(options)).toBe("skipped");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("never retries a timed-out remote result", async () => {
    const release = vi.fn().mockRejectedValue(new Error("timeout"));
    const options = { storage: memory(), task, accountScope: "alice", isCurrent: () => true, release };
    await expect(releaseIdleInstance(options)).rejects.toThrow("timeout");
    expect(await releaseIdleInstance(options)).toBe("skipped");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("fails closed on storage failure and rechecks the account after claiming", async () => {
    const release = vi.fn();
    let current = true;
    const backend = memory();
    const storage: RuntimeStorage = { ...backend, async set(key, value) { await backend.set(key, value); current = false; } };
    expect(await releaseIdleInstance({ storage, task, accountScope: "alice", isCurrent: () => current, release })).toBe("skipped");
    expect(release).not.toHaveBeenCalled();
    await expect(releaseIdleInstance({ storage: { ...backend, async get() { throw new Error("disk"); } }, task, accountScope: "bob", isCurrent: () => true, release })).rejects.toThrow("disk");
    expect(release).not.toHaveBeenCalled();
  });

  it("isolates accounts and new incarnations of a task id", async () => {
    const storage = memory();
    const release = vi.fn().mockResolvedValue({});
    for (const [accountScope, create_time] of [["alice", "a"], ["bob", "a"], ["alice", "b"]]) {
      expect(await releaseIdleInstance({ storage, task: { ...task, create_time }, accountScope, isCurrent: () => true, release })).toBe("released");
    }
    expect(release).toHaveBeenCalledTimes(3);
  });
});
