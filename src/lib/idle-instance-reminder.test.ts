import { describe, expect, it } from "vitest";

import {
  evaluateIdleInstance,
  getIdleInstanceReminder,
  IDLE_CPU_THRESHOLD_PERCENT,
  IDLE_NETWORK_THRESHOLD_BPS,
} from "./idle-instance-reminder";
import type { MonitorMetricSeries, Task } from "./types";

const WINDOW_MS = 60 * 60_000;
const NOW = Date.parse("2026-10-26T12:00:00");

/** Samples every `stepMs` ending at NOW; epoch seconds or milliseconds. */
function series(values: number[], unit: "s" | "ms" = "ms", stepMs = 10 * 60_000): MonitorMetricSeries {
  return {
    name: "test",
    data: values.map((value, index) => ({
      timestamp: Math.floor((NOW - (values.length - 1 - index) * stepMs) / (unit === "ms" ? 1 : 1000)),
      value,
    })),
  };
}

describe("evaluateIdleInstance", () => {
  it("marks all-low series as idle (seconds and milliseconds timestamps)", () => {
    // Seven samples every 10 minutes span the full hour.
    expect(evaluateIdleInstance({ cpu: [series([1, 2, 1, 0, 1, 2, 1])], network: [series([0, 512, 0, 0, 0, 0, 0])] }, NOW, WINDOW_MS)).toBe("idle");
    expect(evaluateIdleInstance({ cpu: [series([1, 2, 1, 0, 1, 2, 1], "s")] }, NOW, WINDOW_MS)).toBe("idle");
  });

  it("marks a CPU or network spike as active", () => {
    expect(evaluateIdleInstance({ cpu: [series([1, 80, 1, 0, 1, 1, 1])], network: [series([0, 0, 0, 0, 0, 0, 0])] }, NOW, WINDOW_MS)).toBe("active");
    expect(
      evaluateIdleInstance({ cpu: [series([1, 2, 1, 0, 1, 2, 1])], network: [series([0, 5 * IDLE_NETWORK_THRESHOLD_BPS, 0, 0, 0, 0, 0])] }, NOW, WINDOW_MS),
    ).toBe("active");
  });

  it("returns unknown for missing, empty, or too-thin data", () => {
    expect(evaluateIdleInstance({}, NOW, WINDOW_MS)).toBe("unknown");
    expect(evaluateIdleInstance({ cpu: [{ data: [] }] }, NOW, WINDOW_MS)).toBe("unknown");
    // One sample cannot span the window.
    expect(evaluateIdleInstance({ cpu: [series([1])] }, NOW, WINDOW_MS)).toBe("unknown");
    // Six samples every 10 minutes span 50 minutes — under half of a 2-hour window.
    expect(evaluateIdleInstance({ cpu: [series([1, 1, 1, 1, 1, 1])] }, NOW, 2 * WINDOW_MS)).toBe("unknown");
  });

  it("ignores points outside the window", () => {
    // The spike is 2 hours old; the recent window is quiet.
    const stale = series([1, 1, 1, 1, 1, 1, 90]);
    const adjusted: MonitorMetricSeries = {
      data: stale.data!.map((point, index) =>
        index === 6 ? { timestamp: point.timestamp! - 2 * 60 * 60_000, value: point.value } : point,
      ),
    };
    expect(evaluateIdleInstance({ cpu: [adjusted] }, NOW, WINDOW_MS)).toBe("idle");
  });

  it("treats threshold values as idle (inclusive)", () => {
    expect(
      evaluateIdleInstance({ cpu: [series([IDLE_CPU_THRESHOLD_PERCENT, IDLE_CPU_THRESHOLD_PERCENT, IDLE_CPU_THRESHOLD_PERCENT, IDLE_CPU_THRESHOLD_PERCENT, IDLE_CPU_THRESHOLD_PERCENT, IDLE_CPU_THRESHOLD_PERCENT, IDLE_CPU_THRESHOLD_PERCENT])] }, NOW, WINDOW_MS),
    ).toBe("idle");
    expect(
      evaluateIdleInstance({ cpu: [series([IDLE_CPU_THRESHOLD_PERCENT + 0.1, 0, 0, 0, 0, 0, 0])] }, NOW, WINDOW_MS),
    ).toBe("active");
  });
});

describe("getIdleInstanceReminder", () => {
  const task = { id: 7, task_id: "task-7", name: "train", status: 2 } as Task;

  it("builds a localized reminder that names the task and the heuristic", () => {
    const zh = getIdleInstanceReminder(task, "zh-CN");
    expect(zh.title).toBe("实例可能闲置");
    expect(zh.body).toContain("train");
    expect(zh.body).toContain("GPU");
    expect(zh.routeId).toBe("7");
    expect(zh.tag).toBe("easy-console-idle-task-7");

    const en = getIdleInstanceReminder(task, "en-US");
    expect(en.title).toBe("Instance may be idle");
    expect(en.body).toContain("heuristic");
  });
});
